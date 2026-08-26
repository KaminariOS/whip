//! Rust-owned lifecycle for one connected Whip/Herdr host.

use std::collections::HashMap;
use std::sync::{
    Arc, OnceLock, Weak,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use tokio::sync::{Notify, watch};

use crate::agent_sessions::{AgentSessionError, AgentSessionManager, AgentSessionOpenResult};
use crate::agent_transcript::{AgentTranscriptKind, AgentTranscriptState};
use crate::herdr_api::{
    HerdrControlError, HerdrControlRequest, HerdrControlResult, request_on_runtime,
};
use crate::herdr_events::{
    HerdrEvent, HerdrEventError, close_herdr_event_subscription, start_on_runtime as start_events,
};
use crate::herdr_terminal::{
    HerdrTerminalAttachLaunchMode, close_all_herdr_terminal_bridges, close_herdr_terminal_bridge,
    herdr_terminal_input, herdr_terminal_resize, herdr_terminal_scroll, start_bridge_on_runtime,
};
use crate::host_state::{ApplyResult, HostState, HostStateSnapshot, now_ms};
use crate::ssh::{SshConnectionConfig, SshCredential, SshFailure, SshSession};

const MAX_RECONNECT_ATTEMPTS: u32 = 5;
const INITIAL_RECONNECT_DELAY_MS: u64 = 750;
const MAX_RECONNECT_DELAY_MS: u64 = 8_000;
static NEXT_RUNTIME_ID: AtomicU64 = AtomicU64::new(1);
static RUNTIMES: OnceLock<RwLock<HashMap<String, Weak<RuntimeInner>>>> = OnceLock::new();
static EVENT_SINK: OnceLock<RwLock<Option<Arc<dyn HostRuntimeEventSink>>>> = OnceLock::new();

fn runtimes() -> &'static RwLock<HashMap<String, Weak<RuntimeInner>>> {
    RUNTIMES.get_or_init(|| RwLock::new(HashMap::new()))
}

fn event_sink() -> &'static RwLock<Option<Arc<dyn HostRuntimeEventSink>>> {
    EVENT_SINK.get_or_init(|| RwLock::new(None))
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum HostSshCredential {
    Password {
        password: String,
    },
    Key {
        private_key: String,
        passphrase: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct HostSshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub credential: HostSshCredential,
    pub forward_agent: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct HostRuntimeConfig {
    pub runtime_id: String,
    pub ssh: HostSshConfig,
    pub jump_hosts: Vec<HostSshConfig>,
    pub session_name: String,
    pub socket_path: Option<String>,
    pub cached_socket_path: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum HostConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Disconnecting,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum HostTerminalState {
    Opening,
    Attached,
    Restoring,
    Closed,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct HostRuntimeStatus {
    pub state: HostConnectionState,
    pub generation: u64,
    pub reconnect_attempt: u32,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
// UniFFI data enums cannot box an associated record. Herdr events remain typed
// instead of crossing the native boundary as serialized JSON.
#[allow(clippy::large_enum_variant)]
pub enum HostRuntimeEvent {
    ConnectionStateChanged {
        runtime_id: String,
        status: HostRuntimeStatus,
    },
    ReconnectScheduled {
        runtime_id: String,
        attempt: u32,
        delay_ms: u64,
        reason: String,
    },
    Reconnected {
        runtime_id: String,
        generation: u64,
        restored_terminals: u32,
    },
    TerminalStateChanged {
        runtime_id: String,
        terminal_id: String,
        state: HostTerminalState,
        error: Option<String>,
    },
    SshShellData {
        runtime_id: String,
        terminal_id: String,
        bytes: Vec<u8>,
    },
    SshShellClosed {
        runtime_id: String,
        terminal_id: String,
        reason: String,
    },
    HostStateChanged {
        runtime_id: String,
        state: HostStateSnapshot,
        changed_agent_pane_ids: Vec<String>,
    },
    EventSubscriptionClosed {
        runtime_id: String,
        reason: String,
    },
    EventSubscriptionRestored {
        runtime_id: String,
        generation: u64,
    },
    FatalError {
        runtime_id: String,
        message: String,
    },
}

#[uniffi::export(with_foreign)]
pub trait HostRuntimeEventSink: Send + Sync {
    fn event(&self, event: HostRuntimeEvent);
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct HostSftpEntry {
    pub filename: String,
    pub is_directory: bool,
    pub modification_date: String,
    pub last_access: String,
    pub file_size: u64,
    pub owner_user_id: u32,
    pub owner_group_id: u32,
    pub permissions: String,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct HostSftpFileServer {
    pub local_port: u16,
    pub token: String,
}

#[derive(Clone, Debug, thiserror::Error, uniffi::Error, PartialEq, Eq)]
pub enum HostRuntimeError {
    #[error("{0}")]
    AuthenticationFailure(String),
    #[error("{0}")]
    HostKeyFailure(String),
    #[error("{0}")]
    SshTransportFailure(String),
    #[error("{0}")]
    HerdrUnavailable(String),
    #[error("{0}")]
    ControlConnectionFailure(String),
    #[error("{0}")]
    ReconnectExhausted(String),
    #[error("{0}")]
    RuntimeDisconnected(String),
    #[error("{0}")]
    TerminalUnavailable(String),
    #[error("{0}")]
    StaleOperation(String),
    #[error("{0}")]
    InvalidConfiguration(String),
}

impl From<SshFailure> for HostRuntimeError {
    fn from(error: SshFailure) -> Self {
        match error.code.as_str() {
            "AUTHENTICATION_FAILED" => Self::AuthenticationFailure(error.message),
            "HOST_KEY_UNKNOWN" | "HOST_KEY_CHANGED" => Self::HostKeyFailure(error.message),
            _ => Self::SshTransportFailure(error.message),
        }
    }
}

#[derive(Clone, Debug)]
struct TerminalRuntime {
    state: HostTerminalState,
    takeover: bool,
    columns: u32,
    rows: u32,
    cell_width_px: u32,
    cell_height_px: u32,
    operation_epoch: u64,
    retry_running: bool,
}

#[derive(Clone, Debug)]
struct EventSubscriptionRuntime {
    pane_ids: Vec<String>,
    operation_epoch: u64,
    retry_running: bool,
}

#[derive(Debug)]
struct RuntimeState {
    connection: HostConnectionState,
    generation: u64,
    epoch: u64,
    reconnect_attempt: u32,
    reconnect_running: bool,
    explicit_disconnect: bool,
    last_error: Option<String>,
    socket_path: Option<String>,
    socket_from_cache: bool,
    protocol: Option<u32>,
    event: Option<EventSubscriptionRuntime>,
    terminals: HashMap<String, TerminalRuntime>,
    host_state: HostState,
}

impl RuntimeState {
    fn new(config: &HostRuntimeConfig) -> Self {
        let socket_path = config
            .socket_path
            .clone()
            .or_else(|| config.cached_socket_path.clone());
        Self {
            connection: HostConnectionState::Disconnected,
            generation: 0,
            epoch: 0,
            reconnect_attempt: 0,
            reconnect_running: false,
            explicit_disconnect: false,
            last_error: None,
            socket_path,
            socket_from_cache: config.socket_path.is_none() && config.cached_socket_path.is_some(),
            protocol: None,
            event: None,
            terminals: HashMap::new(),
            host_state: HostState::default(),
        }
    }

    fn status(&self) -> HostRuntimeStatus {
        HostRuntimeStatus {
            state: self.connection,
            generation: self.generation,
            reconnect_attempt: self.reconnect_attempt,
            error: self.last_error.clone(),
        }
    }

    fn begin_connect(&mut self) -> Result<u64, HostRuntimeError> {
        match self.connection {
            HostConnectionState::Connecting | HostConnectionState::Reconnecting => {
                return Err(HostRuntimeError::StaleOperation(
                    "a host connection operation is already active".to_owned(),
                ));
            }
            HostConnectionState::Connected => return Ok(self.epoch),
            _ => {}
        }
        self.epoch = self.epoch.wrapping_add(1);
        self.connection = HostConnectionState::Connecting;
        self.explicit_disconnect = false;
        self.last_error = None;
        Ok(self.epoch)
    }

    fn install_connection(&mut self, epoch: u64) -> bool {
        if self.epoch != epoch || self.explicit_disconnect {
            return false;
        }
        self.generation = self.generation.wrapping_add(1);
        self.connection = HostConnectionState::Connected;
        self.reconnect_attempt = 0;
        self.reconnect_running = false;
        self.last_error = None;
        self.host_state.connection_installed(self.generation);
        true
    }

    fn disconnect(&mut self) -> u64 {
        self.epoch = self.epoch.wrapping_add(1);
        self.connection = HostConnectionState::Disconnecting;
        self.explicit_disconnect = true;
        self.reconnect_running = false;
        self.reconnect_attempt = 0;
        self.event = None;
        for terminal in self.terminals.values_mut() {
            terminal.operation_epoch = terminal.operation_epoch.wrapping_add(1);
            terminal.state = HostTerminalState::Closed;
            terminal.retry_running = false;
        }
        self.host_state.mark_disconnected();
        self.epoch
    }
}

struct RuntimeInner {
    id: String,
    config: HostRuntimeConfig,
    state: Mutex<RuntimeState>,
    ssh: Arc<RwLock<Option<Arc<SshSession>>>>,
    jump_sessions: Mutex<Vec<Arc<SshSession>>>,
    agents: AgentSessionManager,
    cancellation: watch::Sender<u64>,
    settled: Notify,
}

#[derive(uniffi::Object)]
pub struct HostRuntime {
    inner: Arc<RuntimeInner>,
}

fn emit(event: HostRuntimeEvent) {
    // Foreign callbacks may synchronously re-enter HostRuntime. Never retain
    // either the sink registry lock or a runtime-state lock across the call.
    let sink = event_sink().read().clone();
    if let Some(sink) = sink {
        sink.event(event);
    }
}

fn emit_status(inner: &RuntimeInner) {
    let status = inner.state.lock().status();
    emit(HostRuntimeEvent::ConnectionStateChanged {
        runtime_id: inner.id.clone(),
        status,
    });
}

fn emit_host_state(inner: &RuntimeInner, changed_agent_pane_ids: Vec<String>) {
    let state = inner.state.lock().host_state.projection();
    emit(HostRuntimeEvent::HostStateChanged {
        runtime_id: inner.id.clone(),
        state,
        changed_agent_pane_ids,
    });
}

fn validate_config(config: &HostRuntimeConfig) -> Result<(), HostRuntimeError> {
    for ssh in std::iter::once(&config.ssh).chain(config.jump_hosts.iter()) {
        if ssh.host.trim().is_empty() || ssh.username.trim().is_empty() || ssh.port == 0 {
            return Err(HostRuntimeError::InvalidConfiguration(
                "SSH host, username, and port are required".to_owned(),
            ));
        }
    }
    if let Some(path) = config.socket_path.as_deref()
        && !path.starts_with('/')
    {
        return Err(HostRuntimeError::InvalidConfiguration(
            "Herdr API socket override must be absolute".to_owned(),
        ));
    }
    Ok(())
}

fn current_ssh(inner: &RuntimeInner) -> Result<Arc<SshSession>, HostRuntimeError> {
    inner.ssh.read().clone().ok_or_else(|| {
        HostRuntimeError::RuntimeDisconnected("host SSH session is disconnected".to_owned())
    })
}

fn ssh_config(config: &HostSshConfig) -> SshConnectionConfig {
    SshConnectionConfig {
        host: config.host.trim().to_owned(),
        port: config.port,
        username: config.username.trim().to_owned(),
        credential: match &config.credential {
            HostSshCredential::Password { password } => SshCredential::Password(password.clone()),
            HostSshCredential::Key {
                private_key,
                passphrase,
            } => SshCredential::Key {
                private_key: private_key.clone(),
                passphrase: passphrase.clone(),
            },
        },
        forward_agent: config.forward_agent,
    }
}

async fn disconnect_sessions(sessions: Vec<Arc<SshSession>>) {
    for session in sessions.into_iter().rev() {
        session.disconnect().await;
    }
}

async fn connect_chain(
    inner: &RuntimeInner,
) -> Result<(Arc<SshSession>, Vec<Arc<SshSession>>), HostRuntimeError> {
    let mut jumps: Vec<Arc<SshSession>> = Vec::new();
    for jump in &inner.config.jump_hosts {
        match SshSession::connect(&ssh_config(jump), jumps.last().map(Arc::as_ref)).await {
            Ok(session) => jumps.push(session),
            Err(error) => {
                disconnect_sessions(jumps).await;
                return Err(error.into());
            }
        }
    }
    match SshSession::connect(
        &ssh_config(&inner.config.ssh),
        jumps.last().map(Arc::as_ref),
    )
    .await
    {
        Ok(session) => Ok((session, jumps)),
        Err(error) => {
            disconnect_sessions(jumps).await;
            Err(error.into())
        }
    }
}

async fn finish_connection(
    inner: Arc<RuntimeInner>,
    epoch: u64,
    ssh: Arc<SshSession>,
    jumps: Vec<Arc<SshSession>>,
    restoring: bool,
) -> Result<u32, HostRuntimeError> {
    let installed = {
        let mut state = inner.state.lock();
        if !state.install_connection(epoch) {
            None
        } else {
            let old_ssh = inner.ssh.write().replace(ssh.clone());
            let old_jumps = std::mem::replace(&mut *inner.jump_sessions.lock(), jumps.clone());
            Some((old_ssh, old_jumps))
        }
    };
    let Some((old_ssh, old_jumps)) = installed else {
        ssh.disconnect().await;
        disconnect_sessions(jumps).await;
        return Err(HostRuntimeError::StaleOperation(
            "stale host connection completed after a newer lifecycle operation".to_owned(),
        ));
    };
    if let Some(old_ssh) = old_ssh {
        old_ssh.disconnect().await;
    }
    disconnect_sessions(old_jumps).await;
    let generation = inner.state.lock().generation;
    inner.agents.connected(generation);
    emit_status(&inner);
    emit_host_state(&inner, Vec::new());
    let restored = if restoring {
        restore_resources(inner.clone(), epoch).await
    } else {
        0
    };
    let _ = refresh_host_state_inner(inner.clone()).await;
    {
        let state = inner.state.lock();
        if state.epoch != epoch || state.connection != HostConnectionState::Connected {
            return Err(HostRuntimeError::StaleOperation(
                "host state sync was superseded by another lifecycle operation".to_owned(),
            ));
        }
    }
    inner.settled.notify_waiters();
    Ok(restored)
}

async fn initial_connect(inner: Arc<RuntimeInner>) -> Result<(), HostRuntimeError> {
    if inner.state.lock().connection == HostConnectionState::Connected {
        return Ok(());
    }
    let epoch = inner.state.lock().begin_connect()?;
    let _ = inner.cancellation.send(epoch);
    emit_status(&inner);
    match connect_chain(&inner).await {
        Ok((ssh, jumps)) => {
            finish_connection(inner, epoch, ssh, jumps, false).await?;
            Ok(())
        }
        Err(error) => {
            let mut state = inner.state.lock();
            if state.epoch == epoch {
                state.connection = HostConnectionState::Failed;
                state.last_error = Some(error.to_string());
                state.host_state.mark_reconnecting(error.to_string());
            }
            drop(state);
            emit_status(&inner);
            emit_host_state(&inner, Vec::new());
            inner.settled.notify_waiters();
            Err(error)
        }
    }
}

fn backoff_upper_bound(attempt: u32) -> u64 {
    INITIAL_RECONNECT_DELAY_MS
        .saturating_mul(1_u64 << attempt.saturating_sub(1).min(20))
        .min(MAX_RECONNECT_DELAY_MS)
}

fn reconnect_delay(attempt: u32, random_unit: f64) -> u64 {
    let random_unit = random_unit.clamp(0.0, 1.0);
    (backoff_upper_bound(attempt) as f64 * (0.5 + random_unit * 0.5)).round() as u64
}

fn runtime_jitter(inner: &RuntimeInner, attempt: u32) -> f64 {
    let value = inner.id.bytes().fold(
        u64::from(attempt).wrapping_mul(0x9e37_79b9),
        |hash, byte| hash.rotate_left(5) ^ u64::from(byte),
    );
    (value % 10_000) as f64 / 9_999.0
}

fn begin_reconnect(inner: Arc<RuntimeInner>, reason: String, immediate: bool) -> bool {
    let epoch = {
        let mut state = inner.state.lock();
        if state.explicit_disconnect || state.reconnect_running {
            return false;
        }
        state.epoch = state.epoch.wrapping_add(1);
        state.connection = HostConnectionState::Reconnecting;
        state.reconnect_running = true;
        state.reconnect_attempt = 0;
        state.last_error = Some(reason.clone());
        state.host_state.mark_reconnecting(reason.clone());
        state.epoch
    };
    let _ = inner.cancellation.send(epoch);
    inner.agents.disconnected(false, &reason);
    emit_status(&inner);
    emit_host_state(&inner, Vec::new());
    crate::runtime()
        .ok()
        .map(|runtime| {
            runtime.spawn(reconnect_loop(inner, epoch, reason, immediate));
        })
        .is_some()
}

async fn reconnect_loop(
    inner: Arc<RuntimeInner>,
    epoch: u64,
    initial_reason: String,
    immediate: bool,
) {
    close_herdr_event_subscription(inner.id.clone());
    close_all_herdr_terminal_bridges(inner.id.clone());
    let mut cancellation = inner.cancellation.subscribe();
    let mut last_error = initial_reason;
    for attempt in 1..=MAX_RECONNECT_ATTEMPTS {
        let delay_ms = if immediate && attempt == 1 {
            0
        } else {
            reconnect_delay(attempt, runtime_jitter(&inner, attempt))
        };
        {
            let mut state = inner.state.lock();
            if state.epoch != epoch || state.explicit_disconnect {
                return;
            }
            state.reconnect_attempt = attempt;
        }
        emit(HostRuntimeEvent::ReconnectScheduled {
            runtime_id: inner.id.clone(),
            attempt,
            delay_ms,
            reason: last_error.clone(),
        });
        if delay_ms > 0 {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(delay_ms)) => {}
                _ = cancellation.changed() => return,
            }
        }
        match connect_chain(&inner).await {
            Ok((ssh, jumps)) => {
                match finish_connection(inner.clone(), epoch, ssh, jumps, true).await {
                    Ok(restored) => {
                        let generation = inner.state.lock().generation;
                        emit(HostRuntimeEvent::Reconnected {
                            runtime_id: inner.id.clone(),
                            generation,
                            restored_terminals: restored,
                        });
                        return;
                    }
                    Err(_) => return,
                }
            }
            Err(error) => last_error = error.to_string(),
        }
    }
    {
        let mut state = inner.state.lock();
        if state.epoch != epoch || state.explicit_disconnect {
            return;
        }
        state.connection = HostConnectionState::Failed;
        state.reconnect_running = false;
        state.last_error = Some(last_error.clone());
        state.host_state.mark_reconnecting(last_error.clone());
    }
    emit_status(&inner);
    emit_host_state(&inner, Vec::new());
    emit(HostRuntimeEvent::FatalError {
        runtime_id: inner.id.clone(),
        message: format!(
            "host reconnect exhausted after {MAX_RECONNECT_ATTEMPTS} attempts: {last_error}"
        ),
    });
    inner.settled.notify_waiters();
}

async fn wait_for_reconnect(inner: &RuntimeInner) -> Result<(), HostRuntimeError> {
    loop {
        let status = inner.state.lock().status();
        match status.state {
            HostConnectionState::Connected => return Ok(()),
            HostConnectionState::Reconnecting | HostConnectionState::Connecting => {
                inner.settled.notified().await;
            }
            HostConnectionState::Failed => {
                return Err(HostRuntimeError::ReconnectExhausted(
                    status
                        .error
                        .unwrap_or_else(|| "host reconnect failed".to_owned()),
                ));
            }
            _ => {
                return Err(HostRuntimeError::RuntimeDisconnected(
                    "host runtime is disconnected".to_owned(),
                ));
            }
        }
    }
}

async fn resolve_socket_path(inner: &RuntimeInner) -> Result<String, HostRuntimeError> {
    if let Some(path) = inner.state.lock().socket_path.clone() {
        return Ok(path);
    }
    let output = current_ssh(inner)?.execute(r#"printf %s "$HOME""#).await?;
    let home = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let home = (!home.is_empty()).then_some(home).ok_or_else(|| {
        HostRuntimeError::ControlConnectionFailure(
            "SSH transport returned an invalid remote home directory".to_owned(),
        )
    })?;
    let data_dir = if inner.config.session_name.trim().is_empty() {
        format!("{home}/.config/herdr")
    } else {
        format!(
            "{home}/.config/herdr/sessions/{}",
            inner.config.session_name.trim()
        )
    };
    let socket = format!("{data_dir}/herdr.sock");
    let mut state = inner.state.lock();
    state.socket_path = Some(socket.clone());
    state.socket_from_cache = false;
    Ok(socket)
}

fn client_socket_path(api_socket: &str) -> String {
    api_socket
        .strip_suffix(".sock")
        .map(|prefix| format!("{prefix}-client.sock"))
        .unwrap_or_else(|| format!("{api_socket}-client"))
}

fn is_transport_control_error(error: &HerdrControlError) -> bool {
    matches!(
        error,
        HerdrControlError::TransportDisconnected(_) | HerdrControlError::RequestTimeout(_)
    )
}

fn idempotent_replay(request: &HerdrControlRequest) -> bool {
    matches!(
        request,
        HerdrControlRequest::WorkspaceFocus { .. }
            | HerdrControlRequest::TabFocus { .. }
            | HerdrControlRequest::PaneFocus { .. }
            | HerdrControlRequest::AgentFocus { .. }
    )
}

fn safe_socket_path_replay(request: &HerdrControlRequest) -> bool {
    idempotent_replay(request)
        || matches!(
            request,
            HerdrControlRequest::Ping
                | HerdrControlRequest::SessionSnapshot
                | HerdrControlRequest::PaneRead { .. }
        )
}

fn update_server_from_result(inner: &RuntimeInner, socket: String, result: &HerdrControlResult) {
    let protocol = match result {
        HerdrControlResult::Pong { protocol, .. } => Some(*protocol),
        HerdrControlResult::SessionSnapshot { snapshot } => Some(snapshot.protocol),
        _ => None,
    };
    if let Some(protocol) = protocol {
        let mut state = inner.state.lock();
        state.socket_path = Some(socket);
        state.socket_from_cache = false;
        state.protocol = Some(protocol);
    }
}

async fn ensure_herdr_server(inner: &RuntimeInner) -> Result<(), HostRuntimeError> {
    if inner.state.lock().protocol.is_some() {
        return Ok(());
    }
    let socket = resolve_socket_path(inner).await?;
    let result = request_on_runtime(
        inner.id.clone(),
        current_ssh(inner)?,
        socket.clone(),
        HerdrControlRequest::Ping,
    )
    .await
    .map_err(|error| HostRuntimeError::HerdrUnavailable(error.to_string()))?;
    update_server_from_result(inner, socket, &result);
    if inner.state.lock().protocol.is_none() {
        return Err(HostRuntimeError::HerdrUnavailable(
            "Herdr ping response did not include a protocol".to_owned(),
        ));
    }
    Ok(())
}

async fn control_request_inner(
    inner: Arc<RuntimeInner>,
    request: HerdrControlRequest,
) -> Result<HerdrControlResult, HerdrControlError> {
    let request_for_state = request.clone();
    let state = inner.state.lock().connection;
    if state != HostConnectionState::Connected {
        return Err(HerdrControlError::TransportDisconnected(format!(
            "host runtime is {state:?}"
        )));
    }
    let mut socket = resolve_socket_path(&inner)
        .await
        .map_err(|error| HerdrControlError::TransportDisconnected(error.to_string()))?;
    let mut result = request_on_runtime(
        inner.id.clone(),
        current_ssh(&inner)
            .map_err(|error| HerdrControlError::TransportDisconnected(error.to_string()))?,
        socket.clone(),
        request.clone(),
    )
    .await;
    if result
        .as_ref()
        .err()
        .is_some_and(is_transport_control_error)
        && inner.state.lock().socket_from_cache
        && safe_socket_path_replay(&request)
    {
        {
            let mut state = inner.state.lock();
            state.socket_path = None;
            state.socket_from_cache = false;
        }
        socket = resolve_socket_path(&inner)
            .await
            .map_err(|error| HerdrControlError::TransportDisconnected(error.to_string()))?;
        result = request_on_runtime(
            inner.id.clone(),
            current_ssh(&inner)
                .map_err(|error| HerdrControlError::TransportDisconnected(error.to_string()))?,
            socket.clone(),
            request.clone(),
        )
        .await;
    }
    match result {
        Ok(result) => {
            update_server_from_result(&inner, socket, &result);
            reconcile_control_result(&inner, &request_for_state, &result);
            Ok(result)
        }
        Err(error) if is_transport_control_error(&error) => {
            // A missing Herdr socket is a product availability state, not proof
            // that the authenticated SSH transport died. HostState records the
            // failed snapshot as unavailable while retaining any known state.
            if matches!(request_for_state, HerdrControlRequest::SessionSnapshot) {
                return Err(error);
            }
            let reason = error.to_string();
            if idempotent_replay(&request) {
                begin_reconnect(inner.clone(), reason, true);
                wait_for_reconnect(&inner)
                    .await
                    .map_err(|error| HerdrControlError::TransportDisconnected(error.to_string()))?;
                let socket = resolve_socket_path(&inner)
                    .await
                    .map_err(|error| HerdrControlError::TransportDisconnected(error.to_string()))?;
                let result = request_on_runtime(
                    inner.id.clone(),
                    current_ssh(&inner).map_err(|error| {
                        HerdrControlError::TransportDisconnected(error.to_string())
                    })?,
                    socket.clone(),
                    request,
                )
                .await?;
                update_server_from_result(&inner, socket, &result);
                reconcile_control_result(&inner, &request_for_state, &result);
                Ok(result)
            } else {
                begin_reconnect(inner.clone(), reason, false);
                Err(error)
            }
        }
        Err(error) => Err(error),
    }
}

fn reconcile_control_result(
    inner: &Arc<RuntimeInner>,
    request: &HerdrControlRequest,
    result: &HerdrControlResult,
) {
    if matches!(result, HerdrControlResult::SessionSnapshot { .. }) {
        return;
    }
    let outcome = {
        let mut state = inner.state.lock();
        let generation = state.generation;
        state
            .host_state
            .apply_control_result(generation, request, result)
    };
    if !matches!(outcome, ApplyResult::IgnoredStale) {
        emit_host_state(inner, Vec::new());
    }
    if let ApplyResult::NeedsResync(reason) = outcome {
        schedule_state_resync(inner.clone(), reason);
    }
}

async fn refresh_host_state_inner(inner: Arc<RuntimeInner>) -> HostStateSnapshot {
    let (connection_generation, token) = {
        let mut state = inner.state.lock();
        let generation = state.generation;
        let token = state.host_state.begin_sync(generation);
        (generation, token)
    };
    emit_host_state(&inner, Vec::new());
    let response = control_request_inner(inner.clone(), HerdrControlRequest::SessionSnapshot).await;
    let response = match response {
        Err(error) if is_transport_control_error(&error) => {
            // Preserve the existing cold-connect behavior: retry the direct
            // stream-local channel once without repeating SSH authentication.
            control_request_inner(inner.clone(), HerdrControlRequest::SessionSnapshot).await
        }
        response => response,
    };
    let outcome = match response {
        Ok(HerdrControlResult::SessionSnapshot { snapshot }) => inner
            .state
            .lock()
            .host_state
            .complete_sync(token, snapshot, now_ms()),
        Ok(_) => inner.state.lock().host_state.fail_sync(
            token,
            "Herdr returned an unexpected result for session.snapshot".to_owned(),
        ),
        Err(error) => inner
            .state
            .lock()
            .host_state
            .fail_sync(token, error.to_string()),
    };
    emit_host_state(&inner, Vec::new());
    if matches!(outcome, ApplyResult::Applied)
        && inner.state.lock().generation == connection_generation
        && let Err(error) = start_or_update_state_events(inner.clone()).await
    {
        let reason = error.to_string();
        emit(HostRuntimeEvent::EventSubscriptionClosed {
            runtime_id: inner.id.clone(),
            reason: reason.clone(),
        });
        schedule_event_retry(inner.clone(), reason);
    }
    inner.state.lock().host_state.projection()
}

fn schedule_state_resync(inner: Arc<RuntimeInner>, reason: String) {
    let should_spawn = inner.state.lock().host_state.request_resync(reason);
    if !should_spawn {
        return;
    }
    if let Ok(runtime) = crate::runtime() {
        runtime.spawn(async move {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let should_refresh = {
                let mut state = inner.state.lock();
                state.connection == HostConnectionState::Connected
                    && !state.explicit_disconnect
                    && state.host_state.take_resync_request()
            };
            if should_refresh {
                let _ = refresh_host_state_inner(inner).await;
            }
        });
    }
}

async fn start_desired_events(inner: Arc<RuntimeInner>, epoch: u64) -> Result<(), HerdrEventError> {
    let (socket, protocol, pane_ids, operation_epoch) = {
        let state = inner.state.lock();
        let event = state.event.as_ref().ok_or_else(|| {
            HerdrEventError::SubscriptionUnavailable(
                "event subscription is not requested".to_owned(),
            )
        })?;
        (
            state.socket_path.clone().ok_or_else(|| {
                HerdrEventError::SubscriptionUnavailable("Herdr socket is unknown".to_owned())
            })?,
            state.protocol.ok_or_else(|| {
                HerdrEventError::UnsupportedProtocol("Herdr protocol is unknown".to_owned())
            })?,
            event.pane_ids.clone(),
            event.operation_epoch,
        )
    };
    let ssh = current_ssh(&inner)
        .map_err(|error| HerdrEventError::TransportDisconnected(error.to_string()))?;
    start_events(inner.id.clone(), ssh, socket, protocol, pane_ids).await?;
    let state = inner.state.lock();
    if state.epoch != epoch
        || state
            .event
            .as_ref()
            .is_none_or(|event| event.operation_epoch != operation_epoch)
    {
        drop(state);
        close_herdr_event_subscription(inner.id.clone());
        return Err(HerdrEventError::SubscriptionUnavailable(
            "stale event subscription completed after replacement".to_owned(),
        ));
    }
    Ok(())
}

async fn start_or_update_state_events(inner: Arc<RuntimeInner>) -> Result<(), HerdrEventError> {
    ensure_herdr_server(&inner)
        .await
        .map_err(|error| HerdrEventError::SubscriptionUnavailable(error.to_string()))?;
    let (epoch, changed) = {
        let mut state = inner.state.lock();
        let pane_ids = state.host_state.pane_ids();
        if state
            .event
            .as_ref()
            .is_some_and(|event| event.pane_ids == pane_ids && !event.retry_running)
        {
            (state.epoch, false)
        } else {
            let operation_epoch = state
                .event
                .as_ref()
                .map_or(1, |event| event.operation_epoch.wrapping_add(1));
            state.event = Some(EventSubscriptionRuntime {
                pane_ids,
                operation_epoch,
                retry_running: false,
            });
            (state.epoch, true)
        }
    };
    if !changed {
        return Ok(());
    }
    close_herdr_event_subscription(inner.id.clone());
    start_desired_events(inner, epoch).await
}

async fn open_terminal_inner(
    inner: Arc<RuntimeInner>,
    terminal_id: String,
    operation_epoch: u64,
    restoring: bool,
) -> Result<(), HostRuntimeError> {
    ensure_herdr_server(&inner).await?;
    let (socket, protocol, terminal) = {
        let state = inner.state.lock();
        if state.connection != HostConnectionState::Connected {
            return Err(HostRuntimeError::RuntimeDisconnected(
                "host runtime is not connected".to_owned(),
            ));
        }
        let terminal = state.terminals.get(&terminal_id).cloned().ok_or_else(|| {
            HostRuntimeError::TerminalUnavailable(format!(
                "terminal {terminal_id} is not registered"
            ))
        })?;
        (
            state.socket_path.clone().ok_or_else(|| {
                HostRuntimeError::HerdrUnavailable("Herdr socket is unknown".to_owned())
            })?,
            state.protocol.ok_or_else(|| {
                HostRuntimeError::HerdrUnavailable("Herdr protocol is unknown".to_owned())
            })?,
            terminal,
        )
    };
    let result = start_bridge_on_runtime(
        inner.id.clone(),
        current_ssh(&inner)?,
        client_socket_path(&socket),
        protocol,
        terminal_id.clone(),
        terminal.takeover,
        terminal.columns,
        terminal.rows,
        terminal.cell_width_px,
        terminal.cell_height_px,
        if protocol >= 20 {
            HerdrTerminalAttachLaunchMode::TerminalAttach
        } else {
            HerdrTerminalAttachLaunchMode::LegacyTerminalAttach
        },
    )
    .await;
    let mut state = inner.state.lock();
    let Some(current) = state.terminals.get_mut(&terminal_id) else {
        drop(state);
        close_herdr_terminal_bridge(inner.id.clone(), terminal_id.clone());
        inner.settled.notify_waiters();
        return Err(HostRuntimeError::StaleOperation(format!(
            "terminal {terminal_id} was closed while opening"
        )));
    };
    if current.operation_epoch != operation_epoch || current.state == HostTerminalState::Closed {
        drop(state);
        close_herdr_terminal_bridge(inner.id.clone(), terminal_id.clone());
        inner.settled.notify_waiters();
        return Err(HostRuntimeError::StaleOperation(format!(
            "stale open completed for terminal {terminal_id}"
        )));
    }
    match result {
        Ok(()) => {
            current.state = HostTerminalState::Attached;
            drop(state);
            emit(HostRuntimeEvent::TerminalStateChanged {
                runtime_id: inner.id.clone(),
                terminal_id,
                state: HostTerminalState::Attached,
                error: None,
            });
            inner.settled.notify_waiters();
            Ok(())
        }
        Err(error) => {
            current.state = HostTerminalState::Failed;
            drop(state);
            let message = if restoring {
                format!("Terminal reattach failed: {error}")
            } else {
                error.to_string()
            };
            emit(HostRuntimeEvent::TerminalStateChanged {
                runtime_id: inner.id.clone(),
                terminal_id,
                state: HostTerminalState::Failed,
                error: Some(message.clone()),
            });
            inner.settled.notify_waiters();
            Err(HostRuntimeError::TerminalUnavailable(message))
        }
    }
}

async fn wait_for_terminal_open(
    inner: &RuntimeInner,
    terminal_id: &str,
    operation_epoch: u64,
) -> Result<(), HostRuntimeError> {
    loop {
        let notified = inner.settled.notified();
        let should_wait = {
            let state = inner.state.lock();
            let terminal = state.terminals.get(terminal_id).ok_or_else(|| {
                HostRuntimeError::StaleOperation(format!(
                    "terminal {terminal_id} was closed while opening"
                ))
            })?;
            if terminal.operation_epoch != operation_epoch {
                return Err(HostRuntimeError::StaleOperation(format!(
                    "terminal {terminal_id} open was superseded"
                )));
            }
            match terminal.state {
                HostTerminalState::Attached => false,
                HostTerminalState::Failed if terminal.retry_running => true,
                HostTerminalState::Failed => {
                    return Err(HostRuntimeError::TerminalUnavailable(format!(
                        "terminal {terminal_id} failed to open"
                    )));
                }
                HostTerminalState::Closed => {
                    return Err(HostRuntimeError::StaleOperation(format!(
                        "terminal {terminal_id} was closed while opening"
                    )));
                }
                HostTerminalState::Opening | HostTerminalState::Restoring => true,
            }
        };
        if !should_wait {
            return Ok(());
        }
        notified.await;
    }
}

async fn open_terminal_with_retry(
    inner: Arc<RuntimeInner>,
    terminal_id: String,
    operation_epoch: u64,
) -> Result<(), HostRuntimeError> {
    let mut last_error = None;
    for attempt in 1..=MAX_RECONNECT_ATTEMPTS {
        if attempt > 1 {
            tokio::time::sleep(Duration::from_millis(reconnect_delay(
                attempt - 1,
                runtime_jitter(&inner, attempt - 1),
            )))
            .await;
        }
        {
            let state = inner.state.lock();
            if state.explicit_disconnect
                || state.connection != HostConnectionState::Connected
                || state.terminals.get(&terminal_id).is_none_or(|terminal| {
                    terminal.operation_epoch != operation_epoch
                        || terminal.state == HostTerminalState::Closed
                })
            {
                return Err(HostRuntimeError::StaleOperation(format!(
                    "terminal {terminal_id} open was cancelled"
                )));
            }
        }
        match open_terminal_inner(inner.clone(), terminal_id.clone(), operation_epoch, false).await
        {
            Ok(()) => {
                if let Some(terminal) = inner.state.lock().terminals.get_mut(&terminal_id) {
                    terminal.retry_running = false;
                }
                return Ok(());
            }
            Err(error @ HostRuntimeError::StaleOperation(_)) => return Err(error),
            Err(error) => last_error = Some(error),
        }
    }
    if let Some(terminal) = inner.state.lock().terminals.get_mut(&terminal_id) {
        terminal.retry_running = false;
    }
    inner.settled.notify_waiters();
    Err(last_error.unwrap_or_else(|| {
        HostRuntimeError::TerminalUnavailable(format!("terminal {terminal_id} failed to open"))
    }))
}

async fn restore_resources(inner: Arc<RuntimeInner>, epoch: u64) -> u32 {
    let event_requested = inner.state.lock().event.is_some();
    if event_requested {
        close_herdr_event_subscription(inner.id.clone());
        if let Err(error) = start_desired_events(inner.clone(), epoch).await {
            emit(HostRuntimeEvent::EventSubscriptionClosed {
                runtime_id: inner.id.clone(),
                reason: error.to_string(),
            });
            schedule_event_retry(inner.clone(), error.to_string());
        }
    }
    let terminals = {
        let mut state = inner.state.lock();
        state
            .terminals
            .iter_mut()
            .filter_map(|(id, terminal)| {
                if terminal.state == HostTerminalState::Closed {
                    None
                } else {
                    terminal.state = HostTerminalState::Restoring;
                    terminal.retry_running = true;
                    Some((id.clone(), terminal.operation_epoch))
                }
            })
            .collect::<Vec<_>>()
    };
    let mut restored = 0;
    for (terminal_id, operation_epoch) in terminals {
        emit(HostRuntimeEvent::TerminalStateChanged {
            runtime_id: inner.id.clone(),
            terminal_id: terminal_id.clone(),
            state: HostTerminalState::Restoring,
            error: None,
        });
        match open_terminal_inner(inner.clone(), terminal_id.clone(), operation_epoch, true).await {
            Ok(()) => {
                if let Some(terminal) = inner.state.lock().terminals.get_mut(&terminal_id) {
                    terminal.retry_running = false;
                }
                restored += 1;
            }
            Err(error) => {
                if let Some(terminal) = inner.state.lock().terminals.get_mut(&terminal_id) {
                    terminal.retry_running = false;
                }
                schedule_terminal_retry(inner.clone(), terminal_id, error.to_string());
            }
        }
    }
    restored
}

fn schedule_event_retry(inner: Arc<RuntimeInner>, reason: String) {
    let (epoch, operation_epoch) = {
        let mut state = inner.state.lock();
        let epoch = state.epoch;
        let explicit_disconnect = state.explicit_disconnect;
        let Some(event) = state.event.as_mut() else {
            return;
        };
        if event.retry_running || explicit_disconnect {
            return;
        }
        event.retry_running = true;
        (epoch, event.operation_epoch)
    };
    if let Ok(runtime) = crate::runtime() {
        runtime.spawn(async move {
            let mut last_error = reason;
            for attempt in 1..=MAX_RECONNECT_ATTEMPTS {
                let delay = reconnect_delay(attempt, runtime_jitter(&inner, attempt));
                tokio::time::sleep(Duration::from_millis(delay)).await;
                {
                    let state = inner.state.lock();
                    if state.epoch != epoch
                        || state.explicit_disconnect
                        || state
                            .event
                            .as_ref()
                            .is_none_or(|event| event.operation_epoch != operation_epoch)
                    {
                        return;
                    }
                }
                close_herdr_event_subscription(inner.id.clone());
                match start_desired_events(inner.clone(), epoch).await {
                    Ok(()) => {
                        let generation = {
                            let mut state = inner.state.lock();
                            if let Some(event) = state.event.as_mut() {
                                event.retry_running = false;
                            }
                            state.generation
                        };
                        emit(HostRuntimeEvent::EventSubscriptionRestored {
                            runtime_id: inner.id.clone(),
                            generation,
                        });
                        schedule_state_resync(
                            inner.clone(),
                            "event subscription restarted after a delivery gap".to_owned(),
                        );
                        return;
                    }
                    Err(error) => last_error = error.to_string(),
                }
            }
            if let Some(event) = inner.state.lock().event.as_mut() {
                event.retry_running = false;
            }
            emit(HostRuntimeEvent::EventSubscriptionClosed {
                runtime_id: inner.id.clone(),
                reason: last_error,
            });
        });
    }
}

fn schedule_terminal_retry(inner: Arc<RuntimeInner>, terminal_id: String, reason: String) {
    let (epoch, operation_epoch) = {
        let mut state = inner.state.lock();
        let epoch = state.epoch;
        let explicit_disconnect = state.explicit_disconnect;
        let Some(terminal) = state.terminals.get_mut(&terminal_id) else {
            return;
        };
        if terminal.retry_running
            || terminal.state == HostTerminalState::Closed
            || explicit_disconnect
        {
            return;
        }
        terminal.retry_running = true;
        terminal.state = HostTerminalState::Failed;
        (epoch, terminal.operation_epoch)
    };
    emit(HostRuntimeEvent::TerminalStateChanged {
        runtime_id: inner.id.clone(),
        terminal_id: terminal_id.clone(),
        state: HostTerminalState::Failed,
        error: Some(reason.clone()),
    });
    if let Ok(runtime) = crate::runtime() {
        runtime.spawn(async move {
            let mut last_error = reason;
            for attempt in 1..=MAX_RECONNECT_ATTEMPTS {
                tokio::time::sleep(Duration::from_millis(reconnect_delay(
                    attempt,
                    runtime_jitter(&inner, attempt),
                )))
                .await;
                {
                    let state = inner.state.lock();
                    if state.epoch != epoch
                        || state.explicit_disconnect
                        || state.terminals.get(&terminal_id).is_none_or(|terminal| {
                            terminal.operation_epoch != operation_epoch
                                || terminal.state == HostTerminalState::Closed
                        })
                    {
                        return;
                    }
                }
                match open_terminal_inner(inner.clone(), terminal_id.clone(), operation_epoch, true)
                    .await
                {
                    Ok(()) => {
                        if let Some(terminal) = inner.state.lock().terminals.get_mut(&terminal_id) {
                            terminal.retry_running = false;
                        }
                        return;
                    }
                    Err(error) => last_error = error.to_string(),
                }
            }
            if let Some(terminal) = inner.state.lock().terminals.get_mut(&terminal_id) {
                terminal.retry_running = false;
            }
            inner.settled.notify_waiters();
            emit(HostRuntimeEvent::TerminalStateChanged {
                runtime_id: inner.id.clone(),
                terminal_id,
                state: HostTerminalState::Failed,
                error: Some(format!("terminal recovery exhausted: {last_error}")),
            });
        });
    }
}

/// Called by the typed event decoder before forwarding a current-generation event.
pub(crate) fn deliver_herdr_event(client_key: &str, event: HerdrEvent) -> bool {
    let runtime = runtimes().read().get(client_key).and_then(Weak::upgrade);
    let Some(runtime) = runtime else { return false };
    let changed_agent_pane_ids = match &event {
        HerdrEvent::PaneAgentStatusChanged { pane_id, .. } => vec![pane_id.clone()],
        _ => Vec::new(),
    };
    let outcome = {
        let mut state = runtime.state.lock();
        if state.connection != HostConnectionState::Connected || state.event.is_none() {
            return true;
        }
        let generation = state.generation;
        state.host_state.apply_event(generation, event, now_ms())
    };
    if !matches!(outcome, ApplyResult::IgnoredStale) {
        emit_host_state(&runtime, changed_agent_pane_ids);
    }
    if let ApplyResult::NeedsResync(reason) = outcome {
        schedule_state_resync(runtime, reason);
    }
    true
}

pub(crate) fn event_subscription_closed(client_key: &str, reason: String) -> bool {
    let runtime = runtimes().read().get(client_key).and_then(Weak::upgrade);
    let Some(runtime) = runtime else { return false };
    let state = runtime.state.lock();
    if state.event.is_none() || state.connection != HostConnectionState::Connected {
        return true;
    }
    drop(state);
    runtime
        .state
        .lock()
        .host_state
        .mark_needs_resync(format!("event subscription closed: {reason}"));
    emit_host_state(&runtime, Vec::new());
    emit(HostRuntimeEvent::EventSubscriptionClosed {
        runtime_id: runtime.id.clone(),
        reason: reason.clone(),
    });
    schedule_event_retry(runtime, reason);
    true
}

pub(crate) fn terminal_bridge_closed(client_key: &str, terminal_id: &str, reason: String) -> bool {
    let runtime = runtimes().read().get(client_key).and_then(Weak::upgrade);
    let Some(runtime) = runtime else { return false };
    if runtime.state.lock().connection != HostConnectionState::Connected {
        return true;
    }
    schedule_terminal_retry(runtime, terminal_id.to_owned(), reason);
    true
}

#[uniffi::export]
pub fn set_host_runtime_event_sink(sink: Arc<dyn HostRuntimeEventSink>) {
    *event_sink().write() = Some(sink);
}

#[uniffi::export]
pub fn clear_host_runtime_event_sink() {
    *event_sink().write() = None;
}

#[uniffi::export]
pub fn create_host_runtime(
    config: HostRuntimeConfig,
) -> Result<Arc<HostRuntime>, HostRuntimeError> {
    validate_config(&config)?;
    let id = if config.runtime_id.trim().is_empty() {
        format!(
            "host-runtime-{}",
            NEXT_RUNTIME_ID.fetch_add(1, Ordering::Relaxed)
        )
    } else {
        config.runtime_id.clone()
    };
    if runtimes().read().get(&id).and_then(Weak::upgrade).is_some() {
        return Err(HostRuntimeError::InvalidConfiguration(format!(
            "host runtime {id} already exists"
        )));
    }
    let (cancellation, _) = watch::channel(0);
    let ssh = Arc::new(RwLock::new(None));
    let inner = Arc::new(RuntimeInner {
        id: id.clone(),
        state: Mutex::new(RuntimeState::new(&config)),
        agents: AgentSessionManager::new(id.clone(), ssh.clone()),
        ssh,
        jump_sessions: Mutex::new(Vec::new()),
        config,
        cancellation,
        settled: Notify::new(),
    });
    runtimes().write().insert(id, Arc::downgrade(&inner));
    Ok(Arc::new(HostRuntime { inner }))
}

#[uniffi::export]
impl HostRuntime {
    pub fn runtime_id(&self) -> String {
        self.inner.id.clone()
    }

    pub fn status(&self) -> HostRuntimeStatus {
        self.inner.state.lock().status()
    }

    pub fn host_state(&self) -> HostStateSnapshot {
        self.inner.state.lock().host_state.projection()
    }

    pub fn open_agent_session(
        &self,
        agent: AgentTranscriptKind,
        terminal_id: String,
        session_id: String,
        cache_blob: Option<Vec<u8>>,
    ) -> Result<AgentSessionOpenResult, AgentSessionError> {
        match agent {
            AgentTranscriptKind::Codex => {
                let (key, state) =
                    self.inner
                        .agents
                        .open_codex(terminal_id, session_id, cache_blob)?;
                Ok(AgentSessionOpenResult { key, state })
            }
            AgentTranscriptKind::OpenCode => Err(AgentSessionError::UnsupportedAgent(
                "OpenCode native session transport is not available yet".to_owned(),
            )),
        }
    }

    pub fn agent_transcript(&self, key: String) -> Result<AgentTranscriptState, AgentSessionError> {
        self.inner.agents.state(&key).ok_or_else(|| {
            AgentSessionError::SessionClosed(format!("agent transcript session {key} is closed"))
        })
    }

    pub fn close_agent_session(&self, key: String) {
        self.inner.agents.close_session(&key);
    }

    pub fn close_agent_terminal(&self, terminal_id: String) {
        self.inner.agents.close_terminal(&terminal_id);
    }

    pub fn confirm_agent_transcript_cache(&self, confirmation_token: String) -> bool {
        self.inner.agents.confirm_cache(&confirmation_token)
    }

    pub async fn refresh_state(&self) -> Result<HostStateSnapshot, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                if inner.state.lock().connection != HostConnectionState::Connected {
                    return Err(HostRuntimeError::RuntimeDisconnected(
                        "host runtime is not connected".to_owned(),
                    ));
                }
                Ok(refresh_host_state_inner(inner).await)
            })
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!(
                    "host state refresh task failed: {error}"
                ))
            })?
    }

    pub fn resolved_socket_path(&self) -> Option<String> {
        self.inner.state.lock().socket_path.clone()
    }

    pub async fn resolve_control_socket(&self) -> Result<String, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move { resolve_socket_path(&inner).await })
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!(
                    "host socket resolution task failed: {error}"
                ))
            })?
    }

    pub async fn connect(&self) -> Result<(), HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(initial_connect(inner))
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!("host runtime task failed: {error}"))
            })?
    }

    pub async fn disconnect(&self) -> Result<(), HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                {
                    let mut state = inner.state.lock();
                    if state.connection == HostConnectionState::Disconnected {
                        drop(state);
                        runtimes().write().remove(&inner.id);
                        return Ok(());
                    }
                    let epoch = state.disconnect();
                    let _ = inner.cancellation.send(epoch);
                }
                emit_status(&inner);
                emit_host_state(&inner, Vec::new());
                inner.agents.disconnected(true, "Host runtime disconnected");
                close_herdr_event_subscription(inner.id.clone());
                close_all_herdr_terminal_bridges(inner.id.clone());
                let ssh = inner.ssh.write().take();
                let jumps = std::mem::take(&mut *inner.jump_sessions.lock());
                if let Some(ssh) = ssh {
                    ssh.disconnect().await;
                }
                disconnect_sessions(jumps).await;
                {
                    let mut state = inner.state.lock();
                    state.connection = HostConnectionState::Disconnected;
                    state.last_error = None;
                }
                emit_status(&inner);
                emit_host_state(&inner, Vec::new());
                inner.settled.notify_waiters();
                runtimes().write().remove(&inner.id);
                Ok(())
            })
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!(
                    "host disconnect task failed: {error}"
                ))
            })?
    }

    pub async fn recover(&self, immediate: bool, reason: String) -> Result<(), HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                begin_reconnect(inner.clone(), reason, immediate);
                wait_for_reconnect(&inner).await
            })
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!("host recovery task failed: {error}"))
            })?
    }

    pub async fn control_request(
        &self,
        request: HerdrControlRequest,
    ) -> Result<HerdrControlResult, HerdrControlError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HerdrControlError::TransportDisconnected)?
            .spawn(control_request_inner(inner, request))
            .await
            .map_err(|error| {
                HerdrControlError::RequestCancelled(format!("host control task failed: {error}"))
            })?
    }

    pub async fn subscribe_events(&self, pane_ids: Vec<String>) -> Result<(), HerdrEventError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HerdrEventError::TransportDisconnected)?
            .spawn(async move {
                close_herdr_event_subscription(inner.id.clone());
                let epoch = {
                    let mut state = inner.state.lock();
                    let operation_epoch = state
                        .event
                        .as_ref()
                        .map_or(1, |event| event.operation_epoch.wrapping_add(1));
                    state.event = Some(EventSubscriptionRuntime {
                        pane_ids,
                        operation_epoch,
                        retry_running: false,
                    });
                    state.epoch
                };
                start_desired_events(inner, epoch).await
            })
            .await
            .map_err(|error| {
                HerdrEventError::SubscriptionUnavailable(format!("host event task failed: {error}"))
            })?
    }

    pub fn unsubscribe_events(&self) {
        self.inner.state.lock().event = None;
        close_herdr_event_subscription(self.inner.id.clone());
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn open_terminal(
        &self,
        terminal_id: String,
        takeover: bool,
        columns: u32,
        rows: u32,
        cell_width_px: u32,
        cell_height_px: u32,
    ) -> Result<(), HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let (operation_epoch, wait_for_existing) = {
                    let mut state = inner.state.lock();
                    if let Some(terminal) = state.terminals.get_mut(&terminal_id) {
                        terminal.takeover = takeover;
                        terminal.columns = columns.max(20);
                        terminal.rows = rows.max(8);
                        terminal.cell_width_px = cell_width_px;
                        terminal.cell_height_px = cell_height_px;
                        if terminal.state == HostTerminalState::Attached {
                            return Ok(());
                        }
                        if matches!(
                            terminal.state,
                            HostTerminalState::Opening | HostTerminalState::Restoring
                        ) {
                            (terminal.operation_epoch, true)
                        } else {
                            terminal.operation_epoch = terminal.operation_epoch.wrapping_add(1);
                            terminal.state = HostTerminalState::Opening;
                            terminal.retry_running = true;
                            (terminal.operation_epoch, false)
                        }
                    } else {
                        state.terminals.insert(
                            terminal_id.clone(),
                            TerminalRuntime {
                                state: HostTerminalState::Opening,
                                takeover,
                                columns: columns.max(20),
                                rows: rows.max(8),
                                cell_width_px,
                                cell_height_px,
                                operation_epoch: 1,
                                retry_running: true,
                            },
                        );
                        (1, false)
                    }
                };
                if wait_for_existing {
                    return wait_for_terminal_open(&inner, &terminal_id, operation_epoch).await;
                }
                emit(HostRuntimeEvent::TerminalStateChanged {
                    runtime_id: inner.id.clone(),
                    terminal_id: terminal_id.clone(),
                    state: HostTerminalState::Opening,
                    error: None,
                });
                open_terminal_with_retry(inner, terminal_id, operation_epoch).await
            })
            .await
            .map_err(|error| {
                HostRuntimeError::TerminalUnavailable(format!("terminal open task failed: {error}"))
            })?
    }

    pub fn terminal_input(
        &self,
        terminal_id: String,
        text: String,
    ) -> Result<(), HostRuntimeError> {
        let state = self.inner.state.lock();
        if state.connection != HostConnectionState::Connected
            || state
                .terminals
                .get(&terminal_id)
                .is_none_or(|terminal| terminal.state != HostTerminalState::Attached)
        {
            return Err(HostRuntimeError::TerminalUnavailable(format!(
                "terminal {terminal_id} is unavailable"
            )));
        }
        drop(state);
        herdr_terminal_input(self.inner.id.clone(), terminal_id, text)
            .map_err(|error| HostRuntimeError::TerminalUnavailable(error.to_string()))
    }

    pub fn resize_terminal(
        &self,
        terminal_id: String,
        columns: u32,
        rows: u32,
        cell_width_px: u32,
        cell_height_px: u32,
    ) -> Result<(), HostRuntimeError> {
        {
            let mut state = self.inner.state.lock();
            let terminal = state.terminals.get_mut(&terminal_id).ok_or_else(|| {
                HostRuntimeError::TerminalUnavailable(format!(
                    "terminal {terminal_id} is not registered"
                ))
            })?;
            terminal.columns = columns.max(20);
            terminal.rows = rows.max(8);
            terminal.cell_width_px = cell_width_px;
            terminal.cell_height_px = cell_height_px;
            if terminal.state != HostTerminalState::Attached {
                return Ok(());
            }
        }
        herdr_terminal_resize(
            self.inner.id.clone(),
            terminal_id,
            columns.max(20),
            rows.max(8),
            cell_width_px,
            cell_height_px,
        )
        .map_err(|error| HostRuntimeError::TerminalUnavailable(error.to_string()))
    }

    pub fn scroll_terminal(
        &self,
        terminal_id: String,
        up: bool,
        lines: u32,
        column: Option<f64>,
        row: Option<f64>,
        modifiers: u8,
    ) -> Result<(), HostRuntimeError> {
        herdr_terminal_scroll(
            self.inner.id.clone(),
            terminal_id,
            up,
            lines,
            column,
            row,
            modifiers,
        )
        .map_err(|error| HostRuntimeError::TerminalUnavailable(error.to_string()))
    }

    pub fn close_terminal(&self, terminal_id: String) {
        self.inner.state.lock().terminals.remove(&terminal_id);
        close_herdr_terminal_bridge(self.inner.id.clone(), terminal_id.clone());
        emit(HostRuntimeEvent::TerminalStateChanged {
            runtime_id: self.inner.id.clone(),
            terminal_id,
            state: HostTerminalState::Closed,
            error: None,
        });
        self.inner.settled.notify_waiters();
    }

    pub fn close_all_terminals(&self) {
        let terminal_ids = self
            .inner
            .state
            .lock()
            .terminals
            .drain()
            .map(|(terminal_id, _)| terminal_id)
            .collect::<Vec<_>>();
        close_all_herdr_terminal_bridges(self.inner.id.clone());
        for terminal_id in terminal_ids {
            emit(HostRuntimeEvent::TerminalStateChanged {
                runtime_id: self.inner.id.clone(),
                terminal_id,
                state: HostTerminalState::Closed,
                error: None,
            });
        }
        self.inner.settled.notify_waiters();
    }

    pub fn has_terminal(&self, terminal_id: String) -> bool {
        self.inner
            .state
            .lock()
            .terminals
            .get(&terminal_id)
            .is_some_and(|terminal| terminal.state == HostTerminalState::Attached)
    }

    pub fn is_terminal_opening(&self, terminal_id: String) -> bool {
        self.inner
            .state
            .lock()
            .terminals
            .get(&terminal_id)
            .is_some_and(|terminal| {
                matches!(
                    terminal.state,
                    HostTerminalState::Opening | HostTerminalState::Restoring
                )
            })
    }

    pub async fn open_ssh_shell(
        &self,
        terminal_id: String,
        columns: u32,
        rows: u32,
    ) -> Result<(), HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let epoch = {
                    let state = inner.state.lock();
                    if state.connection != HostConnectionState::Connected {
                        return Err(HostRuntimeError::RuntimeDisconnected(
                            "host runtime is not connected".to_owned(),
                        ));
                    }
                    state.epoch
                };
                let ssh = current_ssh(&inner)?;
                let runtime_id = inner.id.clone();
                let data_terminal_id = terminal_id.clone();
                let data = Arc::new(move |bytes| {
                    emit(HostRuntimeEvent::SshShellData {
                        runtime_id: runtime_id.clone(),
                        terminal_id: data_terminal_id.clone(),
                        bytes,
                    });
                });
                let runtime_id = inner.id.clone();
                let closed_terminal_id = terminal_id.clone();
                let closed = Arc::new(move |reason| {
                    emit(HostRuntimeEvent::SshShellClosed {
                        runtime_id: runtime_id.clone(),
                        terminal_id: closed_terminal_id.clone(),
                        reason,
                    });
                });
                ssh.open_shell(
                    &terminal_id,
                    "xterm-256color",
                    columns.max(20),
                    rows.max(8),
                    data,
                    closed,
                )
                .await?;
                let stale = {
                    let state = inner.state.lock();
                    state.epoch != epoch || state.connection != HostConnectionState::Connected
                };
                if stale {
                    let _ = ssh.close_shell(&terminal_id);
                    return Err(HostRuntimeError::StaleOperation(format!(
                        "SSH shell {terminal_id} opened after its connection was replaced"
                    )));
                }
                Ok(())
            })
            .await
            .map_err(|error| {
                HostRuntimeError::TerminalUnavailable(format!(
                    "SSH shell open task failed: {error}"
                ))
            })?
    }

    pub fn ssh_shell_input(
        &self,
        terminal_id: String,
        bytes: Vec<u8>,
    ) -> Result<(), HostRuntimeError> {
        current_ssh(&self.inner)?.shell_input(&terminal_id, bytes)?;
        Ok(())
    }

    pub fn resize_ssh_shell(
        &self,
        terminal_id: String,
        columns: u32,
        rows: u32,
    ) -> Result<(), HostRuntimeError> {
        current_ssh(&self.inner)?.resize_shell(&terminal_id, columns.max(20), rows.max(8))?;
        Ok(())
    }

    pub fn close_ssh_shell(&self, terminal_id: String) {
        if let Ok(ssh) = current_ssh(&self.inner) {
            let _ = ssh.close_shell(&terminal_id);
        }
    }

    pub fn has_ssh_shell(&self, terminal_id: String) -> bool {
        current_ssh(&self.inner).is_ok_and(|ssh| ssh.has_shell(&terminal_id))
    }

    pub async fn execute(&self, command: String) -> Result<String, HostRuntimeError> {
        let ssh = current_ssh(&self.inner)?;
        let output = crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move { ssh.execute(&command).await })
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!("SSH command task failed: {error}"))
            })??;
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    pub async fn remote_home(&self) -> Result<String, HostRuntimeError> {
        let ssh = current_ssh(&self.inner)?;
        let home = crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move { ssh.remote_home().await })
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!(
                    "remote home discovery task failed: {error}"
                ))
            })??;
        Ok(home)
    }

    pub async fn measure_host_latency(&self) -> Result<f64, HostRuntimeError> {
        let ssh = current_ssh(&self.inner)?;
        let latency_ms = crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move { ssh.latency_ms().await })
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!("SSH latency task failed: {error}"))
            })??;
        Ok(latency_ms)
    }

    pub async fn open_local_forward(
        &self,
        remote_host: String,
        remote_port: u16,
    ) -> Result<u16, HostRuntimeError> {
        let ssh = current_ssh(&self.inner)?;
        let local_port = crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move { ssh.open_local_forward(&remote_host, remote_port).await })
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!(
                    "local forwarding task failed: {error}"
                ))
            })??;
        Ok(local_port)
    }

    pub fn close_local_forward(&self, local_port: u16) {
        if let Ok(ssh) = current_ssh(&self.inner) {
            ssh.close_local_forward(local_port);
        }
    }

    pub async fn sftp_list(&self, path: String) -> Result<Vec<HostSftpEntry>, HostRuntimeError> {
        let ssh = current_ssh(&self.inner)?;
        let entries = crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move { ssh.sftp_list(&path).await })
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!("SFTP list task failed: {error}"))
            })??;
        Ok(entries
            .into_iter()
            .map(|entry| HostSftpEntry {
                filename: entry.filename,
                is_directory: entry.is_directory,
                modification_date: entry.modification_date,
                last_access: entry.last_access,
                file_size: entry.file_size,
                owner_user_id: entry.owner_user_id,
                owner_group_id: entry.owner_group_id,
                permissions: entry.permissions,
            })
            .collect())
    }

    pub async fn sftp_remove(&self, path: String, directory: bool) -> Result<(), HostRuntimeError> {
        let ssh = current_ssh(&self.inner)?;
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move { ssh.sftp_remove(&path, directory).await })
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!("SFTP remove task failed: {error}"))
            })??;
        Ok(())
    }

    pub async fn sftp_create_dir_all(&self, path: String) -> Result<(), HostRuntimeError> {
        let ssh = current_ssh(&self.inner)?;
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move { ssh.sftp_create_dir_all(&path).await })
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!(
                    "SFTP directory task failed: {error}"
                ))
            })??;
        Ok(())
    }

    pub async fn sftp_upload(
        &self,
        local_path: String,
        remote_path: String,
        exact_path: bool,
    ) -> Result<(), HostRuntimeError> {
        let ssh = current_ssh(&self.inner)?;
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move { ssh.sftp_upload(&local_path, &remote_path, exact_path).await })
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!("SFTP upload task failed: {error}"))
            })??;
        Ok(())
    }

    pub async fn sftp_download(
        &self,
        remote_path: String,
        local_directory: String,
    ) -> Result<String, HostRuntimeError> {
        let ssh = current_ssh(&self.inner)?;
        let path = crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move { ssh.sftp_download(&remote_path, &local_directory).await })
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!("SFTP download task failed: {error}"))
            })??;
        Ok(path)
    }

    pub fn cancel_sftp_upload(&self) {
        if let Ok(ssh) = current_ssh(&self.inner) {
            ssh.cancel_sftp_upload();
        }
    }

    pub async fn start_sftp_file_server(
        &self,
        remote_path: String,
    ) -> Result<HostSftpFileServer, HostRuntimeError> {
        let ssh = current_ssh(&self.inner)?;
        let server = crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move { ssh.start_sftp_file_server(&remote_path).await })
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!(
                    "SFTP file server task failed: {error}"
                ))
            })??;
        Ok(HostSftpFileServer {
            local_port: server.local_port,
            token: server.token,
        })
    }

    pub fn close_sftp_file_server(&self, local_port: u16) {
        if let Ok(ssh) = current_ssh(&self.inner) {
            ssh.close_sftp_file_server(local_port);
        }
    }
}

impl Drop for HostRuntime {
    fn drop(&mut self) {
        if Arc::strong_count(&self.inner) != 1 {
            return;
        }
        let inner = self.inner.clone();
        runtimes().write().remove(&inner.id);
        let epoch = inner.state.lock().disconnect();
        let _ = inner.cancellation.send(epoch);
        inner.agents.disconnected(true, "Host runtime dropped");
        close_herdr_event_subscription(inner.id.clone());
        close_all_herdr_terminal_bridges(inner.id.clone());
        if let Ok(runtime) = crate::runtime() {
            runtime.spawn(async move {
                let ssh = inner.ssh.write().take();
                let jumps = std::mem::take(&mut *inner.jump_sessions.lock());
                if let Some(ssh) = ssh {
                    ssh.disconnect().await;
                }
                disconnect_sessions(jumps).await;
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    struct ReentrantRuntimeSink {
        inner: Arc<RuntimeInner>,
        called: AtomicBool,
        runtime_unlocked: AtomicBool,
        registry_unlocked: AtomicBool,
    }

    impl HostRuntimeEventSink for ReentrantRuntimeSink {
        fn event(&self, _event: HostRuntimeEvent) {
            self.called.store(true, Ordering::SeqCst);
            self.runtime_unlocked
                .store(self.inner.state.try_lock().is_some(), Ordering::SeqCst);
            self.registry_unlocked
                .store(event_sink().try_write().is_some(), Ordering::SeqCst);
        }
    }

    fn config() -> HostRuntimeConfig {
        HostRuntimeConfig {
            runtime_id: "test".to_owned(),
            ssh: HostSshConfig {
                host: "host.test".to_owned(),
                port: 22,
                username: "user".to_owned(),
                credential: HostSshCredential::Password {
                    password: "secret".to_owned(),
                },
                forward_agent: false,
            },
            jump_hosts: Vec::new(),
            session_name: "main".to_owned(),
            socket_path: None,
            cached_socket_path: None,
        }
    }

    #[test]
    fn host_state_callback_can_synchronously_reenter_runtime() {
        let (cancellation, _) = watch::channel(0);
        let ssh = Arc::new(RwLock::new(None));
        let inner = Arc::new(RuntimeInner {
            id: "reentrant-test".to_owned(),
            config: config(),
            state: Mutex::new(RuntimeState::new(&config())),
            agents: AgentSessionManager::new("reentrant-test".to_owned(), ssh.clone()),
            ssh,
            jump_sessions: Mutex::new(Vec::new()),
            cancellation,
            settled: Notify::new(),
        });
        let sink = Arc::new(ReentrantRuntimeSink {
            inner: inner.clone(),
            called: AtomicBool::new(false),
            runtime_unlocked: AtomicBool::new(false),
            registry_unlocked: AtomicBool::new(false),
        });
        set_host_runtime_event_sink(sink.clone());

        emit_host_state(&inner, Vec::new());
        clear_host_runtime_event_sink();

        assert!(sink.called.load(Ordering::SeqCst));
        assert!(sink.runtime_unlocked.load(Ordering::SeqCst));
        assert!(sink.registry_unlocked.load(Ordering::SeqCst));
    }

    #[test]
    fn lifecycle_connect_install_disconnect_is_explicit() {
        let mut state = RuntimeState::new(&config());
        let epoch = state.begin_connect().unwrap();
        assert_eq!(state.connection, HostConnectionState::Connecting);
        assert!(state.install_connection(epoch));
        assert_eq!(state.connection, HostConnectionState::Connected);
        assert_eq!(state.generation, 1);
        state.disconnect();
        assert_eq!(state.connection, HostConnectionState::Disconnecting);
        assert!(state.explicit_disconnect);
    }

    #[test]
    fn repeated_connect_does_not_create_a_second_epoch() {
        let mut state = RuntimeState::new(&config());
        let epoch = state.begin_connect().unwrap();
        assert!(state.install_connection(epoch));
        assert_eq!(state.begin_connect().unwrap(), epoch);
    }

    #[test]
    fn concurrent_connect_is_rejected() {
        let mut state = RuntimeState::new(&config());
        state.begin_connect().unwrap();
        assert!(matches!(
            state.begin_connect(),
            Err(HostRuntimeError::StaleOperation(_))
        ));
    }

    #[test]
    fn stale_connection_cannot_overwrite_newer_epoch() {
        let mut state = RuntimeState::new(&config());
        let old = state.begin_connect().unwrap();
        state.disconnect();
        assert!(!state.install_connection(old));
        assert_eq!(state.generation, 0);
    }

    #[test]
    fn disconnect_closes_terminal_intent_and_event_subscription() {
        let mut state = RuntimeState::new(&config());
        state.event = Some(EventSubscriptionRuntime {
            pane_ids: vec!["p1".to_owned()],
            operation_epoch: 1,
            retry_running: true,
        });
        state.terminals.insert(
            "t1".to_owned(),
            TerminalRuntime {
                state: HostTerminalState::Restoring,
                takeover: true,
                columns: 91,
                rows: 33,
                cell_width_px: 8,
                cell_height_px: 16,
                operation_epoch: 2,
                retry_running: true,
            },
        );
        state.disconnect();
        assert!(state.event.is_none());
        let terminal = &state.terminals["t1"];
        assert_eq!(terminal.state, HostTerminalState::Closed);
        assert!(!terminal.retry_running);
        assert_eq!(terminal.operation_epoch, 3);
    }

    #[test]
    fn backoff_matches_the_typescript_policy_boundaries() {
        assert_eq!(reconnect_delay(1, 1.0), 750);
        assert_eq!(reconnect_delay(2, 1.0), 1_500);
        assert_eq!(reconnect_delay(5, 1.0), 8_000);
        assert_eq!(reconnect_delay(1, 0.0), 375);
        assert_eq!(reconnect_delay(5, 0.0), 4_000);
    }

    #[test]
    fn only_focus_operations_are_replayed() {
        assert!(idempotent_replay(&HerdrControlRequest::WorkspaceFocus {
            workspace_id: "w".to_owned()
        }));
        assert!(idempotent_replay(&HerdrControlRequest::AgentFocus {
            target: "a".to_owned()
        }));
        assert!(!idempotent_replay(&HerdrControlRequest::WorkspaceClose {
            workspace_id: "w".to_owned()
        }));
    }

    #[test]
    fn terminal_geometry_survives_restoring_state() {
        let terminal = TerminalRuntime {
            state: HostTerminalState::Restoring,
            takeover: true,
            columns: 132,
            rows: 47,
            cell_width_px: 9,
            cell_height_px: 18,
            operation_epoch: 7,
            retry_running: false,
        };
        assert_eq!(
            (
                terminal.columns,
                terminal.rows,
                terminal.cell_width_px,
                terminal.cell_height_px
            ),
            (132, 47, 9, 18)
        );
        assert!(terminal.takeover);
    }

    #[test]
    fn socket_path_preserves_override_and_cached_origin() {
        let mut explicit = config();
        explicit.socket_path = Some("/run/herdr.sock".to_owned());
        explicit.cached_socket_path = Some("/old.sock".to_owned());
        let state = RuntimeState::new(&explicit);
        assert_eq!(state.socket_path.as_deref(), Some("/run/herdr.sock"));
        assert!(!state.socket_from_cache);
        let mut cached = config();
        cached.cached_socket_path = Some("/cached.sock".to_owned());
        assert!(RuntimeState::new(&cached).socket_from_cache);
    }

    #[test]
    fn client_socket_derivation_matches_existing_behavior() {
        assert_eq!(
            client_socket_path("/tmp/herdr.sock"),
            "/tmp/herdr-client.sock"
        );
        assert_eq!(client_socket_path("/tmp/control"), "/tmp/control-client");
    }

    #[test]
    fn malformed_config_is_rejected_without_panicking() {
        let mut invalid = config();
        invalid.ssh.port = 0;
        assert!(matches!(
            validate_config(&invalid),
            Err(HostRuntimeError::InvalidConfiguration(_))
        ));
        invalid.ssh.port = 22;
        invalid.socket_path = Some("relative.sock".to_owned());
        assert!(matches!(
            validate_config(&invalid),
            Err(HostRuntimeError::InvalidConfiguration(_))
        ));
    }

    #[test]
    fn generation_advances_only_after_a_connection_wins() {
        let mut state = RuntimeState::new(&config());
        let first = state.begin_connect().unwrap();
        assert_eq!(state.generation, 0);
        assert!(state.install_connection(first));
        assert_eq!(state.generation, 1);
        state.connection = HostConnectionState::Failed;
        let second = state.begin_connect().unwrap();
        assert_eq!(state.generation, 1);
        assert!(state.install_connection(second));
        assert_eq!(state.generation, 2);
    }

    #[test]
    fn disconnect_while_connecting_invalidates_the_connect_epoch() {
        let mut state = RuntimeState::new(&config());
        let connecting = state.begin_connect().unwrap();
        let disconnecting = state.disconnect();
        assert_ne!(connecting, disconnecting);
        assert!(!state.install_connection(connecting));
    }

    #[test]
    fn disconnect_while_reconnecting_prevents_replacement_install() {
        let mut state = RuntimeState::new(&config());
        state.connection = HostConnectionState::Reconnecting;
        state.reconnect_running = true;
        state.epoch = 8;
        let replacement = state.epoch;
        state.disconnect();
        assert!(!state.install_connection(replacement));
        assert!(!state.reconnect_running);
    }

    #[test]
    fn stale_event_subscription_epoch_is_detectable_after_restart() {
        let mut state = RuntimeState::new(&config());
        state.event = Some(EventSubscriptionRuntime {
            pane_ids: vec!["old".to_owned()],
            operation_epoch: 4,
            retry_running: true,
        });
        let stale = state.event.as_ref().unwrap().operation_epoch;
        state.event = Some(EventSubscriptionRuntime {
            pane_ids: vec!["new".to_owned()],
            operation_epoch: stale + 1,
            retry_running: false,
        });
        assert_ne!(state.event.as_ref().unwrap().operation_epoch, stale);
        assert_eq!(state.event.as_ref().unwrap().pane_ids, ["new"]);
    }

    #[test]
    fn old_subscription_cannot_survive_explicit_disconnect() {
        let mut state = RuntimeState::new(&config());
        state.event = Some(EventSubscriptionRuntime {
            pane_ids: vec![],
            operation_epoch: 9,
            retry_running: false,
        });
        state.disconnect();
        assert!(state.event.is_none());
        assert!(state.explicit_disconnect);
    }

    #[test]
    fn closing_terminal_during_restore_invalidates_operation() {
        let mut terminal = TerminalRuntime {
            state: HostTerminalState::Restoring,
            takeover: true,
            columns: 80,
            rows: 24,
            cell_width_px: 0,
            cell_height_px: 0,
            operation_epoch: 5,
            retry_running: true,
        };
        let restoring = terminal.operation_epoch;
        terminal.operation_epoch = terminal.operation_epoch.wrapping_add(1);
        terminal.state = HostTerminalState::Closed;
        terminal.retry_running = false;
        assert_ne!(terminal.operation_epoch, restoring);
        assert_eq!(terminal.state, HostTerminalState::Closed);
    }

    #[test]
    fn terminal_failure_does_not_change_host_connection_state() {
        let mut state = RuntimeState::new(&config());
        state.connection = HostConnectionState::Connected;
        state.terminals.insert(
            "failed".to_owned(),
            TerminalRuntime {
                state: HostTerminalState::Failed,
                takeover: true,
                columns: 80,
                rows: 24,
                cell_width_px: 0,
                cell_height_px: 0,
                operation_epoch: 1,
                retry_running: false,
            },
        );
        assert_eq!(state.connection, HostConnectionState::Connected);
        assert_eq!(state.terminals["failed"].state, HostTerminalState::Failed);
    }

    #[test]
    fn one_failed_terminal_does_not_close_other_terminal_intent() {
        let mut failed = TerminalRuntime {
            state: HostTerminalState::Restoring,
            takeover: true,
            columns: 80,
            rows: 24,
            cell_width_px: 0,
            cell_height_px: 0,
            operation_epoch: 1,
            retry_running: false,
        };
        let attached = failed.clone();
        failed.state = HostTerminalState::Failed;
        assert_eq!(attached.state, HostTerminalState::Restoring);
        assert_eq!(failed.state, HostTerminalState::Failed);
    }

    #[test]
    fn reconnect_delay_clamps_untrusted_random_source() {
        assert_eq!(reconnect_delay(1, -10.0), 375);
        assert_eq!(reconnect_delay(1, 10.0), 750);
        assert_eq!(reconnect_delay(u32::MAX, 1.0), 8_000);
    }

    #[test]
    fn status_is_one_coherent_runtime_record() {
        let mut state = RuntimeState::new(&config());
        state.connection = HostConnectionState::Reconnecting;
        state.generation = 7;
        state.reconnect_attempt = 3;
        state.last_error = Some("broken pipe".to_owned());
        let status = state.status();
        assert_eq!(status.state, HostConnectionState::Reconnecting);
        assert_eq!(status.generation, 7);
        assert_eq!(status.reconnect_attempt, 3);
        assert_eq!(status.error.as_deref(), Some("broken pipe"));
    }

    #[test]
    fn valid_jump_chain_configuration_is_accepted() {
        let mut value = config();
        value.jump_hosts.push(HostSshConfig {
            host: "jump.test".to_owned(),
            port: 2222,
            username: "jump".to_owned(),
            credential: HostSshCredential::Key {
                private_key: "private".to_owned(),
                passphrase: None,
            },
            forward_agent: true,
        });
        assert!(validate_config(&value).is_ok());
    }

    #[test]
    fn malformed_jump_host_is_rejected_before_transport_creation() {
        let mut value = config();
        value.jump_hosts.push(HostSshConfig {
            host: String::new(),
            port: 22,
            username: "jump".to_owned(),
            credential: HostSshCredential::Password {
                password: "secret".to_owned(),
            },
            forward_agent: false,
        });
        assert!(matches!(
            validate_config(&value),
            Err(HostRuntimeError::InvalidConfiguration(_))
        ));
    }

    #[test]
    fn all_focus_requests_are_replayable_but_mutations_are_not() {
        assert!(idempotent_replay(&HerdrControlRequest::TabFocus {
            tab_id: "t".to_owned()
        }));
        assert!(idempotent_replay(&HerdrControlRequest::PaneFocus {
            pane_id: "p".to_owned()
        }));
        assert!(!idempotent_replay(&HerdrControlRequest::PaneSendText {
            pane_id: "p".to_owned(),
            text: "hello".to_owned()
        }));
        assert!(safe_socket_path_replay(
            &HerdrControlRequest::SessionSnapshot
        ));
        assert!(safe_socket_path_replay(&HerdrControlRequest::PaneRead {
            pane_id: "p".to_owned(),
            lines: 10
        }));
        assert!(!safe_socket_path_replay(
            &HerdrControlRequest::PaneSendText {
                pane_id: "p".to_owned(),
                text: "hello".to_owned()
            }
        ));
    }
}
