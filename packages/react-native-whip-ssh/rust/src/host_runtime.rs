//! Rust-owned lifecycle for one connected Whip/Herdr host.

mod remote_files;

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{
    Arc, OnceLock, Weak,
    atomic::{AtomicU64, Ordering},
};
use std::time::{Duration, Instant};

use parking_lot::{Mutex, RwLock};
use tokio::sync::{Mutex as AsyncMutex, Notify, watch};

use crate::agent_sessions::{AgentSessionError, AgentSessionManager, AgentSessionOpenResult};
use crate::agent_transcript::{AgentTranscriptKind, AgentTranscriptState};
use crate::herdr_api::{
    HerdrAgentKind, HerdrControlError, HerdrControlRequest, HerdrControlResult,
    HerdrIntegrationInstallResult, HerdrSessionSnapshot, HerdrTabLaunch, HerdrTabLaunchResult,
    HerdrTabLaunchStage, request_on_runtime,
};
use crate::herdr_codec::{MAX_PROTOCOL, MIN_PROTOCOL};
use crate::herdr_connection::{HerdrConnection, HerdrRequestReplay};
use crate::herdr_events::{
    HerdrEvent, HerdrEventError, close_herdr_event_subscription, start_on_runtime as start_events,
};
use crate::herdr_terminal::{
    HerdrBridgeError, HerdrBridgeId, HerdrTerminalAttachLaunchMode,
    active_herdr_terminal_bridge_id, close_all_herdr_terminal_bridges, close_herdr_terminal_bridge,
    close_owned_herdr_terminal_bridge, herdr_terminal_input, herdr_terminal_resize,
    herdr_terminal_scroll, start_bridge_on_runtime,
};
use crate::host_state::{ApplyResult, HostState, HostStateSnapshot, SnapshotToken, now_ms};
use crate::remote_ops::{
    GitDiff, GitRepository, GitStatusEntry, MAX_ACTIVE_PREVIEWS, PreviewInfo, PreviewState,
    REMOTE_TEXT_MAX_BYTES, RemoteDirectoryListing, RemoteFileEntry, RemoteFileKind,
    RemoteOperationManager, TransferProgress, TransferResult, TransferState, attachment_filename,
    git_diff_command, git_repository_command, git_status_command, join_remote_path,
    normalize_remote_path, parse_git_diff, parse_git_repository, parse_git_status, remote_filename,
    shell_quote,
};
use crate::ssh::{SshConnectionConfig, SshCredential, SshErrorCode, SshFailure, SshSession};
use remote_files::*;

const MAX_RECONNECT_ATTEMPTS: u32 = 5;
const INITIAL_RECONNECT_DELAY_MS: u64 = 750;
const MAX_RECONNECT_DELAY_MS: u64 = 8_000;
const HERDR_READINESS_TIMEOUT: Duration = Duration::from_secs(12);
const HERDR_READINESS_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(2);
const HERDR_READINESS_INITIAL_BACKOFF: Duration = Duration::from_millis(75);
const HERDR_READINESS_MAX_BACKOFF: Duration = Duration::from_millis(600);
const SLOW_RUNTIME_DIAGNOSTIC_MS: f64 = 200.0;
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
    pub herdr_command: String,
    pub socket_path: Option<String>,
    pub cached_socket_path: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum AgentIntegrationStatus {
    NotInstalled,
    Current,
    Outdated,
    NeedsRepair,
    Unknown,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum RuntimeDiagnosticOperation {
    SshConnect,
    SshReconnect,
    HostLatencyProbe,
    HerdrRequest,
    TerminalAttach,
    TerminalRecovery,
    EventStreamRecovery,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum RuntimeDiagnosticOutcome {
    Succeeded,
    Failed,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct RuntimeDiagnostic {
    pub operation: RuntimeDiagnosticOperation,
    pub duration_ms: f64,
    pub transport_duration_ms: Option<f64>,
    pub outcome: RuntimeDiagnosticOutcome,
    pub terminal_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, uniffi::Record)]
pub struct HostLatencyMeasurement {
    pub ssh_rtt_ms: f64,
    pub total_ms: f64,
    pub runtime_overhead_ms: f64,
}

#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
// UniFFI data enums cannot box an associated record. Herdr events remain typed
// instead of crossing the native boundary as serialized JSON.
#[allow(
    clippy::large_enum_variant,
    reason = "UniFFI data enums cannot box associated records without changing the native API"
)]
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
        reconnect_attempt: u32,
        retrying: bool,
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
    TransferProgressChanged {
        runtime_id: String,
        progress: TransferProgress,
    },
    PreviewStateChanged {
        runtime_id: String,
        preview_id: String,
        state: PreviewState,
        error: Option<String>,
    },
    Diagnostic {
        runtime_id: String,
        diagnostic: RuntimeDiagnostic,
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

#[derive(Clone, Debug, thiserror::Error, uniffi::Error, PartialEq, Eq)]
pub enum HostRuntimeError {
    #[error("{0}")]
    AuthenticationFailure(String),
    #[error("unknown SSH host key")]
    HostKeyUnknown(crate::ssh::HostKeyChallenge),
    #[error("SSH host key changed")]
    HostKeyChanged(crate::ssh::HostKeyChallenge),
    #[error("SSH host certificates are not supported")]
    UnsupportedHostCertificate,
    #[error("{0}")]
    SshTransportFailure(String),
    #[error("{message}")]
    SshConnectionFailure { code: SshErrorCode, message: String },
    #[error("{0}")]
    HerdrUnavailable(String),
    #[error("Herdr protocol mismatch: Whip supports {expected}, server reports {received}")]
    HerdrProtocolMismatch { expected: String, received: u32 },
    #[error("Herdr did not become ready within {timeout_ms} ms: {last_error}")]
    HerdrReadinessTimeout { timeout_ms: u64, last_error: String },
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
    #[error("{0}")]
    RemoteFileFailure(String),
    #[error("{0}")]
    TransferFailure(String),
    #[error("{0}")]
    TransferCancelled(String),
    #[error("{0}")]
    GitFailure(String),
    #[error("{0}")]
    PreviewFailure(String),
    #[error("pane submission failed after {submitted_parts} completed paste parts: {message}")]
    PaneSubmissionFailure {
        submitted_parts: u32,
        message: String,
    },
}

impl From<SshFailure> for HostRuntimeError {
    fn from(error: SshFailure) -> Self {
        match error {
            SshFailure::Authentication(message) => Self::AuthenticationFailure(message),
            SshFailure::HostKeyUnknown(challenge) => Self::HostKeyUnknown(*challenge),
            SshFailure::HostKeyChanged(challenge) => Self::HostKeyChanged(*challenge),
            SshFailure::UnsupportedHostCertificate => Self::UnsupportedHostCertificate,
            SshFailure::Transport { code, message } => Self::SshConnectionFailure { code, message },
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
    reconnect_attempt: u32,
    retry_running: bool,
    bridge_id: Option<HerdrBridgeId>,
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
    protocol: Option<u32>,
    event: Option<EventSubscriptionRuntime>,
    terminals: HashMap<String, TerminalRuntime>,
    host_state: HostState,
}

impl RuntimeState {
    fn new(_config: &HostRuntimeConfig) -> Self {
        Self {
            connection: HostConnectionState::Disconnected,
            generation: 0,
            epoch: 0,
            reconnect_attempt: 0,
            reconnect_running: false,
            explicit_disconnect: false,
            last_error: None,
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

    fn begin_reconnect(
        &mut self,
        expected_generation: Option<u64>,
        reason: &str,
    ) -> Option<(u64, u64)> {
        if self.explicit_disconnect || self.reconnect_running {
            return None;
        }
        if expected_generation.is_some_and(|generation| {
            self.connection != HostConnectionState::Connected || self.generation != generation
        }) {
            return None;
        }
        self.epoch = self.epoch.wrapping_add(1);
        self.connection = HostConnectionState::Reconnecting;
        self.reconnect_running = true;
        self.reconnect_attempt = 0;
        self.last_error = Some(reason.to_owned());
        self.host_state.mark_reconnecting(reason.to_owned());
        Some((self.epoch, self.generation))
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
            terminal.reconnect_attempt = 0;
            terminal.retry_running = false;
            terminal.bridge_id = None;
        }
        self.host_state.mark_disconnected();
        self.epoch
    }
}

struct RuntimeInner {
    id: String,
    config: HostRuntimeConfig,
    state: Mutex<RuntimeState>,
    herdr: Arc<HerdrConnection>,
    jump_sessions: Mutex<Vec<Arc<SshSession>>>,
    agents: AgentSessionManager,
    operations: RemoteOperationManager,
    herdr_startup: AsyncMutex<()>,
    cancellation: watch::Sender<u64>,
    status_tx: watch::Sender<HostRuntimeStatus>,
    terminal_settled: Notify,
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

fn publish_lifecycle_status(inner: &RuntimeInner) {
    let status = inner.state.lock().status();
    inner.status_tx.send_replace(status.clone());
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

fn elapsed_ms(started_at: Instant) -> f64 {
    started_at.elapsed().as_secs_f64() * 1_000.0
}

fn emit_diagnostic(
    inner: &RuntimeInner,
    operation: RuntimeDiagnosticOperation,
    started_at: Instant,
    transport_duration_ms: Option<f64>,
    terminal_id: Option<String>,
    error: Option<String>,
) {
    let event = HostRuntimeEvent::Diagnostic {
        runtime_id: inner.id.clone(),
        diagnostic: RuntimeDiagnostic {
            operation,
            duration_ms: elapsed_ms(started_at),
            transport_duration_ms,
            outcome: if error.is_some() {
                RuntimeDiagnosticOutcome::Failed
            } else {
                RuntimeDiagnosticOutcome::Succeeded
            },
            terminal_id,
            error,
        },
    };
    // Diagnostics are best-effort observability. A faulty foreign listener
    // must not turn a completed transport operation into a runtime failure.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| emit(event)));
}

fn emit_slow_or_failed_diagnostic(
    inner: &RuntimeInner,
    operation: RuntimeDiagnosticOperation,
    started_at: Instant,
    error: Option<String>,
) {
    if error.is_some() || elapsed_ms(started_at) >= SLOW_RUNTIME_DIAGNOSTIC_MS {
        emit_diagnostic(inner, operation, started_at, None, None, error);
    }
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
    inner.herdr.current_ssh().map_err(|error| {
        HostRuntimeError::RuntimeDisconnected(format!("host SSH transport is unavailable: {error}"))
    })
}

fn current_generation(inner: &RuntimeInner) -> Result<u64, HostRuntimeError> {
    let state = inner.state.lock();
    if state.connection != HostConnectionState::Connected {
        return Err(HostRuntimeError::RuntimeDisconnected(
            "host runtime is not connected".to_owned(),
        ));
    }
    Ok(state.generation)
}

fn validate_generation(inner: &RuntimeInner, generation: u64) -> Result<(), HostRuntimeError> {
    let state = inner.state.lock();
    if state.connection != HostConnectionState::Connected || state.generation != generation {
        return Err(HostRuntimeError::StaleOperation(
            "remote operation completed after its host connection was replaced".to_owned(),
        ));
    }
    drop(state);
    Ok(())
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

fn observe_transport_lifecycle(
    inner: &Arc<RuntimeInner>,
    generation: u64,
    session: Arc<SshSession>,
) {
    let inner = Arc::downgrade(inner);
    if let Ok(runtime) = crate::runtime() {
        runtime.spawn(async move {
            let reason = session.disconnected().await;
            if let Some(inner) = inner.upgrade() {
                begin_reconnect_for_generation(inner, Some(generation), reason, true);
            }
        });
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
            let generation = state.generation;
            let old_ssh = inner.herdr.install(generation, ssh.clone());
            drop(state);
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
    observe_transport_lifecycle(&inner, generation, ssh);
    for jump in jumps {
        observe_transport_lifecycle(&inner, generation, jump);
    }
    inner.agents.connected();
    publish_lifecycle_status(&inner);
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
    Ok(restored)
}

async fn initial_connect(inner: Arc<RuntimeInner>) -> Result<(), HostRuntimeError> {
    if inner.state.lock().connection == HostConnectionState::Connected {
        return Ok(());
    }
    let epoch = inner.state.lock().begin_connect()?;
    let _ = inner.cancellation.send(epoch);
    publish_lifecycle_status(&inner);
    let started_at = Instant::now();
    match connect_chain(&inner).await {
        Ok((ssh, jumps)) => {
            emit_diagnostic(
                &inner,
                RuntimeDiagnosticOperation::SshConnect,
                started_at,
                None,
                None,
                None,
            );
            finish_connection(inner.clone(), epoch, ssh, jumps, false)
                .await
                .map(|_| ())
        }
        Err(error) => {
            let mut state = inner.state.lock();
            if state.epoch == epoch {
                state.connection = HostConnectionState::Failed;
                state.last_error = Some(error.to_string());
                state.host_state.mark_reconnecting(error.to_string());
            }
            drop(state);
            publish_lifecycle_status(&inner);
            emit_host_state(&inner, Vec::new());
            emit_diagnostic(
                &inner,
                RuntimeDiagnosticOperation::SshConnect,
                started_at,
                None,
                None,
                Some(error.to_string()),
            );
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
    let delay = Duration::from_millis(backoff_upper_bound(attempt))
        .mul_f64(0.5 + random_unit * 0.5)
        .saturating_add(Duration::from_micros(500));
    u64::try_from(delay.as_millis()).unwrap_or(MAX_RECONNECT_DELAY_MS)
}

fn runtime_jitter(inner: &RuntimeInner, attempt: u32) -> f64 {
    let value = inner.id.bytes().fold(
        u64::from(attempt).wrapping_mul(0x9e37_79b9),
        |hash, byte| hash.rotate_left(5) ^ u64::from(byte),
    );
    f64::from(u32::try_from(value % 10_000).unwrap_or_default()) / 9_999.0
}

fn begin_reconnect_for_generation(
    inner: Arc<RuntimeInner>,
    expected_generation: Option<u64>,
    reason: String,
    immediate: bool,
) -> bool {
    let Some((epoch, generation)) = ({
        let mut state = inner.state.lock();
        state.begin_reconnect(expected_generation, &reason)
    }) else {
        return false;
    };
    let ssh = inner.herdr.clear(generation);
    let jumps = std::mem::take(&mut *inner.jump_sessions.lock());
    invalidate_remote_operations(&inner, generation, &reason);
    let _ = inner.cancellation.send(epoch);
    inner.agents.disconnected(false, &reason);
    publish_lifecycle_status(&inner);
    emit_host_state(&inner, Vec::new());
    crate::runtime()
        .ok()
        .map(|runtime| {
            runtime.spawn(async move {
                if let Some(ssh) = ssh {
                    ssh.disconnect().await;
                }
                disconnect_sessions(jumps).await;
                reconnect_loop(inner, epoch, reason, immediate).await;
            });
        })
        .is_some()
}

fn begin_reconnect(inner: Arc<RuntimeInner>, reason: String, immediate: bool) -> bool {
    begin_reconnect_for_generation(inner, None, reason, immediate)
}

async fn reconnect_loop(
    inner: Arc<RuntimeInner>,
    epoch: u64,
    initial_reason: String,
    immediate: bool,
) {
    let started_at = Instant::now();
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
            state.last_error = Some(last_error.clone());
        }
        publish_lifecycle_status(&inner);
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
                        emit_diagnostic(
                            &inner,
                            RuntimeDiagnosticOperation::SshReconnect,
                            started_at,
                            None,
                            None,
                            None,
                        );
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
    publish_lifecycle_status(&inner);
    emit_host_state(&inner, Vec::new());
    emit(HostRuntimeEvent::FatalError {
        runtime_id: inner.id.clone(),
        message: format!(
            "host reconnect exhausted after {MAX_RECONNECT_ATTEMPTS} attempts: {last_error}"
        ),
    });
    emit_diagnostic(
        &inner,
        RuntimeDiagnosticOperation::SshReconnect,
        started_at,
        None,
        None,
        Some(last_error),
    );
}

async fn wait_for_reconnect(
    mut status_rx: watch::Receiver<HostRuntimeStatus>,
) -> Result<(), HostRuntimeError> {
    loop {
        let status = status_rx.borrow_and_update().clone();
        match status.state {
            HostConnectionState::Connected => return Ok(()),
            HostConnectionState::Reconnecting | HostConnectionState::Connecting => {}
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
        status_rx.changed().await.map_err(|_| {
            HostRuntimeError::RuntimeDisconnected(
                "host runtime lifecycle ended while waiting for reconnect".to_owned(),
            )
        })?;
    }
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

fn safe_control_replay(request: &HerdrControlRequest) -> bool {
    idempotent_replay(request)
        || matches!(
            request,
            HerdrControlRequest::Ping
                | HerdrControlRequest::SessionSnapshot
                | HerdrControlRequest::PaneRead { .. }
        )
}

fn request_replay(request: &HerdrControlRequest) -> HerdrRequestReplay {
    if safe_control_replay(request) {
        HerdrRequestReplay::AfterSocketRediscovery
    } else {
        HerdrRequestReplay::Never
    }
}

fn update_server_from_result(inner: &RuntimeInner, result: &HerdrControlResult) {
    let protocol = match result {
        HerdrControlResult::Pong { protocol, .. } => Some(*protocol),
        HerdrControlResult::SessionSnapshot { snapshot } => Some(snapshot.protocol),
        _ => None,
    };
    if let Some(protocol) = protocol {
        inner.state.lock().protocol = Some(protocol);
    }
}

async fn ensure_herdr_server(inner: &Arc<RuntimeInner>) -> Result<(), HostRuntimeError> {
    if inner.state.lock().protocol.is_some() {
        return Ok(());
    }
    let result = request_on_runtime(
        inner.herdr.clone(),
        HerdrControlRequest::Ping,
        HerdrRequestReplay::AfterSocketRediscovery,
    )
    .await;
    let result = result.map_err(|error| HostRuntimeError::HerdrUnavailable(error.to_string()))?;
    update_server_from_result(inner, &result);
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
    let pane_close_terminal_id = match &request {
        HerdrControlRequest::PaneClose { pane_id } => {
            inner.state.lock().host_state.terminal_id_for_pane(pane_id)
        }
        _ => None,
    };
    let state = inner.state.lock().connection;
    if state != HostConnectionState::Connected {
        return Err(HerdrControlError::TransportDisconnected(format!(
            "host runtime is {state:?}"
        )));
    }
    let started_at = Instant::now();
    let result = request_on_runtime(
        inner.herdr.clone(),
        request.clone(),
        request_replay(&request),
    )
    .await;
    emit_slow_or_failed_diagnostic(
        &inner,
        RuntimeDiagnosticOperation::HerdrRequest,
        started_at,
        result.as_ref().err().map(ToString::to_string),
    );
    match result {
        Ok(result) => {
            update_server_from_result(&inner, &result);
            reconcile_control_result(
                &inner,
                &request_for_state,
                &result,
                pane_close_terminal_id.as_deref(),
            );
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
                let status_rx = inner.status_tx.subscribe();
                begin_reconnect(inner.clone(), reason, true);
                wait_for_reconnect(status_rx)
                    .await
                    .map_err(|error| HerdrControlError::TransportDisconnected(error.to_string()))?;
                let result = request_on_runtime(
                    inner.herdr.clone(),
                    request,
                    request_replay(&request_for_state),
                )
                .await?;
                update_server_from_result(&inner, &result);
                reconcile_control_result(
                    &inner,
                    &request_for_state,
                    &result,
                    pane_close_terminal_id.as_deref(),
                );
                Ok(result)
            } else {
                begin_reconnect(inner.clone(), reason, false);
                Err(error)
            }
        }
        Err(error) => Err(error),
    }
}

fn managed_agent_name(label: &str, kind: HerdrAgentKind, tab_number: f64) -> String {
    let mut normalized = String::new();
    let mut previous_was_dash = false;
    for character in label.to_lowercase().chars() {
        if character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_' {
            normalized.push(character);
            previous_was_dash = false;
        } else if character == '-' {
            normalized.push(character);
            previous_was_dash = true;
        } else if !previous_was_dash {
            normalized.push('-');
            previous_was_dash = true;
        }
    }
    let first_letter = normalized
        .char_indices()
        .find_map(|(index, character)| character.is_ascii_lowercase().then_some(index));
    normalized = first_letter.map_or_else(String::new, |index| normalized[index..].to_owned());
    while normalized.ends_with('-') {
        normalized.pop();
    }
    if normalized.is_empty() {
        normalized = format!("{}-{tab_number}", kind.as_str());
    }
    normalized.truncate(normalized.len().min(32));
    normalized
}

fn has_shell_command_semantics(command: &str) -> bool {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Quote {
        Single,
        Double,
    }

    let mut quote = None;
    for character in command.chars() {
        match quote {
            Some(Quote::Single) => {
                if character == '\'' {
                    quote = None;
                }
            }
            Some(Quote::Double) => match character {
                '"' => quote = None,
                '$' | '`' | '\n' | '\r' => return true,
                _ => {}
            },
            None => match character {
                '\'' => quote = Some(Quote::Single),
                '"' => quote = Some(Quote::Double),
                '\\' | '\n' | '\r' | '$' | '`' | '|' | '&' | ';' | '<' | '>' | '(' | ')' | '['
                | ']' | '{' | '}' | '*' | '?' | '!' | '#' | '~' => return true,
                _ => {}
            },
        }
    }
    false
}

fn normalize_tab_launch(launch: HerdrTabLaunch) -> Result<HerdrTabLaunch, HerdrControlError> {
    let HerdrTabLaunch::Command { command } = launch else {
        return Ok(launch);
    };
    let command = command.trim().to_owned();
    if command.is_empty() {
        return Err(HerdrControlError::InvalidField(
            "command must not be empty".to_owned(),
        ));
    }
    if has_shell_command_semantics(&command) {
        return Ok(HerdrTabLaunch::Command { command });
    }
    let Some(mut args) = shlex::split(&command) else {
        return Ok(HerdrTabLaunch::Command { command });
    };
    let Some(executable) = args.first() else {
        return Ok(HerdrTabLaunch::Command { command });
    };
    let kind = match executable.as_str() {
        "claude" => HerdrAgentKind::Claude,
        "codex" => HerdrAgentKind::Codex,
        "opencode" => HerdrAgentKind::OpenCode,
        _ => return Ok(HerdrTabLaunch::Command { command }),
    };
    args.remove(0);
    Ok(HerdrTabLaunch::Agent { kind, args })
}

fn launch_request(
    tab: &crate::herdr_api::HerdrTabInfo,
    root_pane: &crate::herdr_api::HerdrPaneInfo,
    launch: HerdrTabLaunch,
) -> Option<(HerdrTabLaunchStage, HerdrControlRequest)> {
    match launch {
        HerdrTabLaunch::Shell => None,
        HerdrTabLaunch::Agent { kind, args } => Some((
            HerdrTabLaunchStage::AgentStart,
            HerdrControlRequest::AgentStart {
                name: managed_agent_name(&tab.label, kind, tab.number),
                kind,
                pane_id: root_pane.pane_id.clone(),
                args,
            },
        )),
        HerdrTabLaunch::Command { command } => Some((
            HerdrTabLaunchStage::CommandInput,
            HerdrControlRequest::PaneSendInput {
                pane_id: root_pane.pane_id.clone(),
                text: command,
                keys: vec!["enter".to_owned()],
            },
        )),
    }
}

async fn create_tab_with_launch_inner(
    inner: Arc<RuntimeInner>,
    workspace_id: String,
    label: String,
    launch: HerdrTabLaunch,
) -> Result<HerdrTabLaunchResult, HerdrControlError> {
    let launch = normalize_tab_launch(launch)?;
    let label = label.trim();
    let created = control_request_inner(
        inner.clone(),
        HerdrControlRequest::TabCreate {
            workspace_id,
            label: (!label.is_empty()).then(|| label.to_owned()),
        },
    )
    .await?;
    let HerdrControlResult::TabCreated { tab, root_pane } = created else {
        return Err(HerdrControlError::UnsupportedResponse(
            "tab.create returned a non-tab result".to_owned(),
        ));
    };
    let Some((stage, request)) = launch_request(&tab, &root_pane, launch) else {
        return Ok(HerdrTabLaunchResult::Created { tab, root_pane });
    };
    match control_request_inner(inner, request).await {
        Ok(_) => Ok(HerdrTabLaunchResult::Created { tab, root_pane }),
        Err(error) => Ok(HerdrTabLaunchResult::LaunchFailed {
            tab,
            root_pane,
            stage,
            failure: error.into(),
        }),
    }
}

fn pane_submission_requests(
    pane_id: String,
    parts: Vec<String>,
) -> Vec<(HerdrControlRequest, bool)> {
    let parts = parts
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.is_empty() {
        return vec![(
            HerdrControlRequest::PaneSendKeys {
                pane_id,
                keys: vec!["enter".to_owned()],
            },
            false,
        )];
    }

    let part_count = parts.len();
    let mut requests = Vec::with_capacity(part_count.saturating_mul(2).saturating_sub(1));
    for (index, text) in parts.into_iter().enumerate() {
        if index > 0 {
            requests.push((
                HerdrControlRequest::PaneSendText {
                    pane_id: pane_id.clone(),
                    text: " ".to_owned(),
                },
                false,
            ));
        }
        requests.push((
            HerdrControlRequest::PaneSendInput {
                pane_id: pane_id.clone(),
                text,
                keys: if index + 1 == part_count {
                    vec!["enter".to_owned()]
                } else {
                    Vec::new()
                },
            },
            true,
        ));
    }
    requests
}

async fn submit_pastes_inner(
    inner: Arc<RuntimeInner>,
    pane_id: String,
    parts: Vec<String>,
) -> Result<(), HostRuntimeError> {
    let mut submitted_parts = 0_u32;
    for (request, completes_part) in pane_submission_requests(pane_id, parts) {
        control_request_inner(inner.clone(), request)
            .await
            .map_err(|error| HostRuntimeError::PaneSubmissionFailure {
                submitted_parts,
                message: error.to_string(),
            })?;
        if completes_part {
            submitted_parts = submitted_parts.saturating_add(1);
        }
    }
    Ok(())
}

fn start_herdr_server_command(herdr_command: &str, session_name: &str) -> String {
    let herdr_command = herdr_command.trim();
    let mut base = shell_quote(if herdr_command.is_empty() {
        "herdr"
    } else {
        herdr_command
    });
    if !session_name.trim().is_empty() {
        base.push_str(" --session ");
        base.push_str(&shell_quote(session_name.trim()));
    }
    let command = format!("nohup {base} server >/tmp/whip-herdr-server.log 2>&1 </dev/null &");
    let bootstrap = r#"exec "${SHELL:-/bin/sh}" -lc "$1""#;
    format!(
        "exec /bin/sh -c {} whip {}",
        shell_quote(bootstrap),
        shell_quote(&command)
    )
}

struct ReadyHerdrSnapshot {
    snapshot: HerdrSessionSnapshot,
}

enum HerdrReadinessProbeError {
    Retryable(String),
    Permanent(HostRuntimeError),
}

enum HerdrReadinessPollError {
    Timeout(String),
    Permanent(HostRuntimeError),
}

fn herdr_protocol_label() -> String {
    format!("{MIN_PROTOCOL}\u{2013}{MAX_PROTOCOL}")
}

fn herdr_readiness_timeout(last_error: impl Into<String>) -> HostRuntimeError {
    HostRuntimeError::HerdrReadinessTimeout {
        timeout_ms: u64::try_from(HERDR_READINESS_TIMEOUT.as_millis()).unwrap_or(u64::MAX),
        last_error: last_error.into(),
    }
}

fn validate_herdr_protocol(protocol: u32) -> Result<(), HostRuntimeError> {
    if (MIN_PROTOCOL..=MAX_PROTOCOL).contains(&protocol) {
        Ok(())
    } else {
        Err(HostRuntimeError::HerdrProtocolMismatch {
            expected: herdr_protocol_label(),
            received: protocol,
        })
    }
}

fn readiness_probe_error(
    inner: &RuntimeInner,
    generation: u64,
    error: HerdrControlError,
) -> HerdrReadinessProbeError {
    if let Err(error) = validate_generation(inner, generation) {
        return HerdrReadinessProbeError::Permanent(error);
    }
    if let Err(error) = current_ssh(inner) {
        return HerdrReadinessProbeError::Permanent(error);
    }
    match error {
        HerdrControlError::TransportDisconnected(message)
        | HerdrControlError::RequestTimeout(message) => {
            HerdrReadinessProbeError::Retryable(message)
        }
        error => HerdrReadinessProbeError::Permanent(HostRuntimeError::ControlConnectionFailure(
            error.to_string(),
        )),
    }
}

async fn probe_herdr_readiness(
    inner: Arc<RuntimeInner>,
    generation: u64,
) -> Result<ReadyHerdrSnapshot, HerdrReadinessProbeError> {
    validate_generation(&inner, generation).map_err(HerdrReadinessProbeError::Permanent)?;
    let request = HerdrControlRequest::SessionSnapshot;
    let result = request_on_runtime(
        inner.herdr.clone(),
        request,
        HerdrRequestReplay::AfterSocketRediscovery,
    )
    .await;
    validate_generation(&inner, generation).map_err(HerdrReadinessProbeError::Permanent)?;
    let result = result.map_err(|error| readiness_probe_error(&inner, generation, error))?;
    let HerdrControlResult::SessionSnapshot { snapshot } = result else {
        return Err(HerdrReadinessProbeError::Permanent(
            HostRuntimeError::ControlConnectionFailure(
                "Herdr returned an unexpected result for session.snapshot".to_owned(),
            ),
        ));
    };
    validate_herdr_protocol(snapshot.protocol).map_err(HerdrReadinessProbeError::Permanent)?;
    Ok(ReadyHerdrSnapshot { snapshot })
}

async fn bounded_readiness_probe(
    inner: Arc<RuntimeInner>,
    generation: u64,
    deadline: Instant,
) -> Result<ReadyHerdrSnapshot, HerdrReadinessProbeError> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(HerdrReadinessProbeError::Retryable(
            "Herdr readiness deadline expired".to_owned(),
        ));
    }
    match tokio::time::timeout(
        remaining.min(HERDR_READINESS_ATTEMPT_TIMEOUT),
        probe_herdr_readiness(inner, generation),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(HerdrReadinessProbeError::Retryable(
            "Herdr readiness probe timed out".to_owned(),
        )),
    }
}

async fn poll_herdr_readiness<F, Fut>(
    deadline: Instant,
    initial_backoff: Duration,
    max_backoff: Duration,
    mut probe: F,
) -> Result<ReadyHerdrSnapshot, HerdrReadinessPollError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<ReadyHerdrSnapshot, HerdrReadinessProbeError>>,
{
    let mut backoff = initial_backoff;
    loop {
        let last_error = match probe().await {
            Ok(ready) => return Ok(ready),
            Err(HerdrReadinessProbeError::Permanent(error)) => {
                return Err(HerdrReadinessPollError::Permanent(error));
            }
            Err(HerdrReadinessProbeError::Retryable(error)) => error,
        };
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(HerdrReadinessPollError::Timeout(last_error));
        }
        tokio::time::sleep(backoff.min(remaining)).await;
        backoff = backoff.saturating_mul(2).min(max_backoff);
    }
}

fn fail_herdr_startup_sync(inner: &RuntimeInner, token: SnapshotToken, error: &HostRuntimeError) {
    inner
        .state
        .lock()
        .host_state
        .fail_sync(token, error.to_string());
    emit_host_state(inner, Vec::new());
}

async fn complete_herdr_startup_sync(
    inner: Arc<RuntimeInner>,
    generation: u64,
    token: SnapshotToken,
    ready: ReadyHerdrSnapshot,
) -> Result<(), HostRuntimeError> {
    let outcome = {
        let mut state = inner.state.lock();
        if state.connection != HostConnectionState::Connected || state.generation != generation {
            return Err(HostRuntimeError::StaleOperation(
                "Herdr startup completed after its host connection was replaced".to_owned(),
            ));
        }
        state.protocol = Some(ready.snapshot.protocol);
        state
            .host_state
            .complete_sync(token, ready.snapshot, now_ms())
    };
    emit_host_state(&inner, Vec::new());
    if matches!(outcome, ApplyResult::IgnoredStale) {
        return Err(HostRuntimeError::StaleOperation(
            "Herdr startup state sync was superseded by a newer host-state operation".to_owned(),
        ));
    }
    reconcile_host_state_subscription(inner.clone(), generation, outcome).await;
    validate_generation(&inner, generation)?;
    let projection = inner.state.lock().host_state.projection();
    if projection.snapshot.is_none() {
        return Err(HostRuntimeError::HerdrUnavailable(
            projection
                .error
                .unwrap_or_else(|| "Herdr startup did not produce host state".to_owned()),
        ));
    }
    Ok(())
}

async fn start_herdr_server_inner(inner: Arc<RuntimeInner>) -> Result<(), HostRuntimeError> {
    let _startup = inner.herdr_startup.lock().await;
    let generation = current_generation(&inner)?;
    let (_, token) = begin_host_state_sync(&inner);
    let deadline = Instant::now() + HERDR_READINESS_TIMEOUT;

    match bounded_readiness_probe(inner.clone(), generation, deadline).await {
        Ok(ready) => {
            return complete_herdr_startup_sync(inner.clone(), generation, token, ready).await;
        }
        Err(HerdrReadinessProbeError::Permanent(error)) => {
            fail_herdr_startup_sync(&inner, token, &error);
            return Err(error);
        }
        Err(HerdrReadinessProbeError::Retryable(_)) => {}
    }

    validate_generation(&inner, generation)?;
    let command =
        start_herdr_server_command(&inner.config.herdr_command, &inner.config.session_name);
    let ssh = current_ssh(&inner)?;
    let remaining = deadline.saturating_duration_since(Instant::now());
    let output = match tokio::time::timeout(remaining, ssh.execute(&command)).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            let error = current_ssh(&inner)
                .err()
                .unwrap_or_else(|| HostRuntimeError::from(error));
            fail_herdr_startup_sync(&inner, token, &error);
            return Err(error);
        }
        Err(_) => {
            let error = herdr_readiness_timeout("Herdr server start command did not complete");
            fail_herdr_startup_sync(&inner, token, &error);
            return Err(error);
        }
    };
    validate_generation(&inner, generation)?;
    if output.exit_status.is_some_and(|status| status != 0) {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let error = HostRuntimeError::HerdrUnavailable(if detail.is_empty() {
            format!(
                "Herdr server start command exited with status {}",
                output.exit_status.unwrap_or_default()
            )
        } else {
            format!(
                "Herdr server start command exited with status {}: {detail}",
                output.exit_status.unwrap_or_default()
            )
        });
        fail_herdr_startup_sync(&inner, token, &error);
        return Err(error);
    }

    let readiness = poll_herdr_readiness(
        deadline,
        HERDR_READINESS_INITIAL_BACKOFF,
        HERDR_READINESS_MAX_BACKOFF,
        || bounded_readiness_probe(inner.clone(), generation, deadline),
    )
    .await;
    match readiness {
        Ok(ready) => complete_herdr_startup_sync(inner.clone(), generation, token, ready).await,
        Err(HerdrReadinessPollError::Permanent(error)) => {
            fail_herdr_startup_sync(&inner, token, &error);
            Err(error)
        }
        Err(HerdrReadinessPollError::Timeout(last_error)) => {
            let error = herdr_readiness_timeout(last_error);
            fail_herdr_startup_sync(&inner, token, &error);
            Err(error)
        }
    }
}

fn integration_status_command(herdr_command: &str) -> String {
    let herdr_command = herdr_command.trim();
    let herdr_command = if herdr_command.is_empty() {
        "herdr"
    } else {
        herdr_command
    };
    let command = format!("{} integration status", shell_quote(herdr_command));
    let bootstrap = r#"exec "${SHELL:-/bin/sh}" -lc "$1""#;
    format!(
        "exec /bin/sh -c {} whip {}",
        shell_quote(bootstrap),
        shell_quote(&command)
    )
}

fn parse_agent_integration_status(output: &str, kind: HerdrAgentKind) -> AgentIntegrationStatus {
    let prefix = format!("{}:", kind.as_str());
    let Some(status) = output.lines().find_map(|line| {
        let line = line.trim().to_lowercase();
        line.strip_prefix(&prefix).map(str::trim).map(str::to_owned)
    }) else {
        return AgentIntegrationStatus::Unknown;
    };
    let matches = |expected: &str| {
        status == expected
            || status
                .strip_prefix(expected)
                .and_then(|suffix| suffix.chars().next())
                .is_some_and(|character| character.is_whitespace() || character == '(')
    };
    if matches("not installed") {
        AgentIntegrationStatus::NotInstalled
    } else if matches("current") {
        AgentIntegrationStatus::Current
    } else if matches("outdated") {
        AgentIntegrationStatus::Outdated
    } else if matches("needs repair") {
        AgentIntegrationStatus::NeedsRepair
    } else {
        AgentIntegrationStatus::Unknown
    }
}

fn reconcile_control_result(
    inner: &Arc<RuntimeInner>,
    request: &HerdrControlRequest,
    result: &HerdrControlResult,
    pane_close_terminal_id: Option<&str>,
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
    if matches!(request, HerdrControlRequest::PaneClose { .. })
        && matches!(result, HerdrControlResult::Ok)
        && !matches!(outcome, ApplyResult::IgnoredStale)
        && let Some(terminal_id) = pane_close_terminal_id
    {
        close_terminal_intent(inner, terminal_id.to_owned());
    }
    match outcome {
        ApplyResult::NeedsResync(reason) => schedule_state_resync(inner.clone(), reason),
        ApplyResult::Applied
            if matches!(
                request,
                HerdrControlRequest::WorkspaceCreate { .. }
                    | HerdrControlRequest::WorkspaceClose { .. }
                    | HerdrControlRequest::TabCreate { .. }
                    | HerdrControlRequest::TabClose { .. }
                    | HerdrControlRequest::PaneSplit { .. }
            ) =>
        {
            schedule_state_resync(
                inner.clone(),
                "control result may have changed the pane event subscription set".to_owned(),
            );
        }
        ApplyResult::Applied | ApplyResult::IgnoredStale => {}
    }
}

fn begin_host_state_sync(inner: &RuntimeInner) -> (u64, SnapshotToken) {
    let (connection_generation, token) = {
        let mut state = inner.state.lock();
        let generation = state.generation;
        let token = state.host_state.begin_sync(generation);
        drop(state);
        (generation, token)
    };
    emit_host_state(inner, Vec::new());
    (connection_generation, token)
}

async fn request_host_state_snapshot(
    inner: Arc<RuntimeInner>,
    token: SnapshotToken,
) -> ApplyResult {
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
    outcome
}

async fn reconcile_host_state_subscription(
    inner: Arc<RuntimeInner>,
    connection_generation: u64,
    outcome: ApplyResult,
) {
    if matches!(outcome, ApplyResult::Applied)
        && inner.state.lock().generation == connection_generation
        && event_subscription_needs_update(&inner)
    {
        // Start the reconciliation generation before opening the subscription.
        // Events can then be buffered as soon as Herdr acknowledges the stream,
        // including events delivered before the follow-up snapshot request.
        let (reconciliation_generation, reconciliation_token) = begin_host_state_sync(&inner);
        match start_or_update_state_events(inner.clone()).await {
            Ok(()) => {
                let reconciliation =
                    request_host_state_snapshot(inner.clone(), reconciliation_token).await;
                if matches!(reconciliation, ApplyResult::Applied)
                    && inner.state.lock().generation == reconciliation_generation
                    && event_subscription_needs_update(&inner)
                {
                    schedule_state_resync(
                        inner,
                        "pane subscription set changed during snapshot reconciliation".to_owned(),
                    );
                }
            }
            Err(error) => {
                let reason = error.to_string();
                inner
                    .state
                    .lock()
                    .host_state
                    .fail_sync(reconciliation_token, reason.clone());
                event_subscription_start_failed(inner, reason);
            }
        }
    }
}

fn event_subscription_needs_update(inner: &RuntimeInner) -> bool {
    let state = inner.state.lock();
    let pane_ids = state.host_state.pane_ids();
    state
        .event
        .as_ref()
        .is_none_or(|event| event.pane_ids != pane_ids || event.retry_running)
}

fn event_subscription_start_failed(inner: Arc<RuntimeInner>, reason: String) {
    inner
        .state
        .lock()
        .host_state
        .mark_needs_resync(format!("event subscription unavailable: {reason}"));
    emit_host_state(&inner, Vec::new());
    emit(HostRuntimeEvent::EventSubscriptionClosed {
        runtime_id: inner.id.clone(),
        reason: reason.clone(),
    });
    schedule_event_retry(inner, reason);
}

async fn refresh_host_state_inner(inner: Arc<RuntimeInner>) -> HostStateSnapshot {
    if let Err(error) = ensure_herdr_server(&inner).await {
        let (_, token) = begin_host_state_sync(&inner);
        inner
            .state
            .lock()
            .host_state
            .fail_sync(token, error.to_string());
        emit_host_state(&inner, Vec::new());
        return inner.state.lock().host_state.projection();
    }

    let (connection_generation, token) = begin_host_state_sync(&inner);
    let outcome = request_host_state_snapshot(inner.clone(), token).await;
    reconcile_host_state_subscription(inner.clone(), connection_generation, outcome).await;
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
    let (protocol, pane_ids, operation_epoch) = {
        let state = inner.state.lock();
        let event = state.event.as_ref().ok_or_else(|| {
            HerdrEventError::SubscriptionUnavailable(
                "event subscription is not requested".to_owned(),
            )
        })?;
        (
            state.protocol.ok_or_else(|| {
                HerdrEventError::UnsupportedProtocol("Herdr protocol is unknown".to_owned())
            })?,
            event.pane_ids.clone(),
            event.operation_epoch,
        )
    };
    start_events(inner.herdr.clone(), protocol, pane_ids).await?;
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

fn close_terminal_intent(inner: &Arc<RuntimeInner>, terminal_id: String) {
    inner.agents.close_terminal(&terminal_id);
    let bridge_id = inner
        .state
        .lock()
        .terminals
        .remove(&terminal_id)
        .and_then(|terminal| terminal.bridge_id);
    if let Some(bridge_id) = bridge_id {
        close_owned_herdr_terminal_bridge(&inner.id, &terminal_id, bridge_id);
    } else {
        close_herdr_terminal_bridge(inner.id.clone(), terminal_id.clone());
    }
    emit(HostRuntimeEvent::TerminalStateChanged {
        runtime_id: inner.id.clone(),
        terminal_id,
        state: HostTerminalState::Closed,
        reconnect_attempt: 0,
        retrying: false,
        error: None,
    });
    inner.terminal_settled.notify_waiters();
}

fn claim_terminal_bridge(
    inner: &RuntimeInner,
    terminal_id: &str,
    operation_epoch: u64,
    bridge_id: HerdrBridgeId,
) -> Result<(), HerdrBridgeError> {
    let mut state = inner.state.lock();
    if state.connection != HostConnectionState::Connected {
        return Err(HerdrBridgeError::BridgeUnavailable(
            "host runtime disconnected while claiming terminal bridge".to_owned(),
        ));
    }
    let terminal = state.terminals.get_mut(terminal_id).ok_or_else(|| {
        HerdrBridgeError::BridgeUnavailable(format!(
            "terminal {terminal_id} closed while claiming bridge {bridge_id}"
        ))
    })?;
    if terminal.operation_epoch != operation_epoch
        || !matches!(
            terminal.state,
            HostTerminalState::Opening | HostTerminalState::Restoring
        )
    {
        return Err(HerdrBridgeError::BridgeUnavailable(format!(
            "terminal {terminal_id} no longer accepts bridge {bridge_id}"
        )));
    }
    terminal.bridge_id = Some(bridge_id);
    drop(state);
    Ok(())
}

fn live_terminal_bridge_id(inner: &RuntimeInner, terminal_id: &str) -> Option<HerdrBridgeId> {
    let bridge_id = {
        let state = inner.state.lock();
        if state.connection != HostConnectionState::Connected {
            return None;
        }
        let terminal = state.terminals.get(terminal_id)?;
        if terminal.state != HostTerminalState::Attached {
            return None;
        }
        let bridge_id = terminal.bridge_id?;
        drop(state);
        bridge_id
    };
    (active_herdr_terminal_bridge_id(&inner.id, terminal_id) == Some(bridge_id))
        .then_some(bridge_id)
}

async fn open_terminal_inner(
    inner: Arc<RuntimeInner>,
    terminal_id: String,
    operation_epoch: u64,
    restoring: bool,
) -> Result<(), HostRuntimeError> {
    let started_at = Instant::now();
    let operation = if restoring {
        RuntimeDiagnosticOperation::TerminalRecovery
    } else {
        RuntimeDiagnosticOperation::TerminalAttach
    };
    ensure_herdr_server(&inner).await?;
    let (protocol, terminal) = {
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
            state.protocol.ok_or_else(|| {
                HostRuntimeError::HerdrUnavailable("Herdr protocol is unknown".to_owned())
            })?,
            terminal,
        )
    };
    let claim_inner = inner.clone();
    let claim_terminal_id = terminal_id.clone();
    let mut result = start_bridge_on_runtime(
        inner.herdr.clone(),
        protocol,
        terminal_id.clone(),
        terminal.takeover,
        terminal.columns,
        terminal.rows,
        terminal.cell_width_px,
        terminal.cell_height_px,
        HerdrTerminalAttachLaunchMode::for_protocol(protocol),
        move |bridge_id| {
            claim_terminal_bridge(
                claim_inner.as_ref(),
                &claim_terminal_id,
                operation_epoch,
                bridge_id,
            )
        },
    )
    .await;
    let opened_bridge_id = result.as_ref().ok().copied();
    let mut state = inner.state.lock();
    let Some(current) = state.terminals.get_mut(&terminal_id) else {
        drop(state);
        if let Some(bridge_id) = opened_bridge_id {
            close_owned_herdr_terminal_bridge(&inner.id, &terminal_id, bridge_id);
        }
        inner.terminal_settled.notify_waiters();
        return Err(HostRuntimeError::StaleOperation(format!(
            "terminal {terminal_id} was closed while opening"
        )));
    };
    if current.operation_epoch != operation_epoch || current.state == HostTerminalState::Closed {
        drop(state);
        if let Some(bridge_id) = opened_bridge_id {
            close_owned_herdr_terminal_bridge(&inner.id, &terminal_id, bridge_id);
        }
        inner.terminal_settled.notify_waiters();
        return Err(HostRuntimeError::StaleOperation(format!(
            "stale open completed for terminal {terminal_id}"
        )));
    }
    if let Ok(&bridge_id) = result.as_ref()
        && (current.bridge_id != Some(bridge_id)
            || !matches!(
                current.state,
                HostTerminalState::Opening | HostTerminalState::Restoring
            )
            || active_herdr_terminal_bridge_id(&inner.id, &terminal_id) != Some(bridge_id))
    {
        result = Err(HerdrBridgeError::BridgeClosed(format!(
            "terminal {terminal_id} bridge {bridge_id} closed before attachment committed"
        )));
    }
    match result {
        Ok(bridge_id) => {
            debug_assert_eq!(current.bridge_id, Some(bridge_id));
            current.state = HostTerminalState::Attached;
            current.reconnect_attempt = 0;
            drop(state);
            emit(HostRuntimeEvent::TerminalStateChanged {
                runtime_id: inner.id.clone(),
                terminal_id: terminal_id.clone(),
                state: HostTerminalState::Attached,
                reconnect_attempt: 0,
                retrying: false,
                error: None,
            });
            emit_diagnostic(
                &inner,
                operation,
                started_at,
                None,
                Some(terminal_id.clone()),
                None,
            );
            inner.terminal_settled.notify_waiters();
            Ok(())
        }
        Err(error) => {
            let failed_bridge_id = current.bridge_id.take().or(opened_bridge_id);
            current.state = HostTerminalState::Failed;
            let reconnect_attempt = current.reconnect_attempt;
            let retrying = current.retry_running;
            drop(state);
            let message = if restoring {
                format!("Terminal reattach failed: {error}")
            } else {
                error.to_string()
            };
            if let Some(bridge_id) = failed_bridge_id {
                close_owned_herdr_terminal_bridge(&inner.id, &terminal_id, bridge_id);
            }
            emit(HostRuntimeEvent::TerminalStateChanged {
                runtime_id: inner.id.clone(),
                terminal_id: terminal_id.clone(),
                state: HostTerminalState::Failed,
                reconnect_attempt,
                retrying,
                error: Some(message.clone()),
            });
            emit_diagnostic(
                &inner,
                operation,
                started_at,
                None,
                Some(terminal_id.clone()),
                Some(message.clone()),
            );
            inner.terminal_settled.notify_waiters();
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
        let notified = inner.terminal_settled.notified();
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
            let should_wait = match terminal.state {
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
            };
            drop(state);
            should_wait
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
            if let Some(terminal) = inner.state.lock().terminals.get_mut(&terminal_id) {
                terminal.state = HostTerminalState::Opening;
                terminal.reconnect_attempt = attempt - 1;
                terminal.bridge_id = None;
            }
            emit(HostRuntimeEvent::TerminalStateChanged {
                runtime_id: inner.id.clone(),
                terminal_id: terminal_id.clone(),
                state: HostTerminalState::Opening,
                reconnect_attempt: attempt - 1,
                retrying: true,
                error: last_error.as_ref().map(ToString::to_string),
            });
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
    inner.terminal_settled.notify_waiters();
    let error = last_error.unwrap_or_else(|| {
        HostRuntimeError::TerminalUnavailable(format!("terminal {terminal_id} failed to open"))
    });
    emit(HostRuntimeEvent::TerminalStateChanged {
        runtime_id: inner.id.clone(),
        terminal_id: terminal_id.clone(),
        state: HostTerminalState::Failed,
        reconnect_attempt: MAX_RECONNECT_ATTEMPTS,
        retrying: false,
        error: Some(format!("terminal recovery exhausted: {error}")),
    });
    Err(error)
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
                    terminal.reconnect_attempt = 0;
                    terminal.retry_running = true;
                    terminal.bridge_id = None;
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
            reconnect_attempt: 0,
            retrying: true,
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
                schedule_terminal_retry(inner.clone(), terminal_id, None, error.to_string());
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
        let operation_epoch = event.operation_epoch;
        drop(state);
        (epoch, operation_epoch)
    };
    if let Ok(runtime) = crate::runtime() {
        runtime.spawn(async move {
            let started_at = Instant::now();
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
                        emit_diagnostic(
                            &inner,
                            RuntimeDiagnosticOperation::EventStreamRecovery,
                            started_at,
                            None,
                            None,
                            None,
                        );
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
                reason: last_error.clone(),
            });
            emit_diagnostic(
                &inner,
                RuntimeDiagnosticOperation::EventStreamRecovery,
                started_at,
                None,
                None,
                Some(last_error),
            );
        });
    }
}

fn schedule_terminal_retry(
    inner: Arc<RuntimeInner>,
    terminal_id: String,
    closed_bridge_id: Option<HerdrBridgeId>,
    reason: String,
) {
    let (epoch, operation_epoch, start_worker, reconnect_attempt, bridge_to_close) = {
        let mut state = inner.state.lock();
        let epoch = state.epoch;
        let explicit_disconnect = state.explicit_disconnect;
        let Some(terminal) = state.terminals.get_mut(&terminal_id) else {
            return;
        };
        if terminal.state == HostTerminalState::Closed || explicit_disconnect {
            return;
        }
        if closed_bridge_id.is_some_and(|bridge_id| terminal.bridge_id != Some(bridge_id)) {
            return;
        }
        let bridge_to_close = closed_bridge_id
            .is_none()
            .then_some(terminal.bridge_id)
            .flatten();
        terminal.bridge_id = None;
        terminal.state = HostTerminalState::Failed;
        let start_worker = !terminal.retry_running;
        if start_worker {
            terminal.retry_running = true;
            terminal.reconnect_attempt = 0;
        }
        let retry_state = (
            epoch,
            terminal.operation_epoch,
            start_worker,
            terminal.reconnect_attempt,
            bridge_to_close,
        );
        drop(state);
        retry_state
    };
    if let Some(bridge_id) = bridge_to_close {
        close_owned_herdr_terminal_bridge(&inner.id, &terminal_id, bridge_id);
    }
    emit(HostRuntimeEvent::TerminalStateChanged {
        runtime_id: inner.id.clone(),
        terminal_id: terminal_id.clone(),
        state: HostTerminalState::Failed,
        reconnect_attempt,
        retrying: true,
        error: Some(reason.clone()),
    });
    inner.terminal_settled.notify_waiters();
    if !start_worker {
        return;
    }
    if let Ok(runtime) = crate::runtime() {
        runtime.spawn(async move {
            let mut last_error = reason;
            for attempt in 1..=MAX_RECONNECT_ATTEMPTS {
                if let Some(terminal) = inner.state.lock().terminals.get_mut(&terminal_id) {
                    terminal.state = HostTerminalState::Restoring;
                    terminal.reconnect_attempt = attempt;
                    terminal.bridge_id = None;
                }
                emit(HostRuntimeEvent::TerminalStateChanged {
                    runtime_id: inner.id.clone(),
                    terminal_id: terminal_id.clone(),
                    state: HostTerminalState::Restoring,
                    reconnect_attempt: attempt,
                    retrying: true,
                    error: Some(last_error.clone()),
                });
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
            inner.terminal_settled.notify_waiters();
            emit(HostRuntimeEvent::TerminalStateChanged {
                runtime_id: inner.id.clone(),
                terminal_id,
                state: HostTerminalState::Failed,
                reconnect_attempt: MAX_RECONNECT_ATTEMPTS,
                retrying: false,
                error: Some(format!("terminal recovery exhausted: {last_error}")),
            });
        });
    }
}

#[derive(Debug, Default)]
struct HerdrEventBatchResult {
    changed: bool,
    changed_agent_pane_ids: Vec<String>,
    resync_reason: Option<String>,
}

fn apply_herdr_event_batch(
    state: &mut RuntimeState,
    events: impl IntoIterator<Item = HerdrEvent>,
) -> HerdrEventBatchResult {
    let mut result = HerdrEventBatchResult::default();
    let mut changed_agent_pane_ids = HashSet::new();
    let generation = state.generation;
    for event in events {
        let changes_projection = !matches!(event, HerdrEvent::PaneOutputChanged { .. });
        let agent_pane_id = match &event {
            HerdrEvent::PaneAgentStatusChanged { pane_id, .. } => Some(pane_id.clone()),
            _ => None,
        };
        let outcome = state.host_state.apply_event(generation, event, now_ms());
        if matches!(outcome, ApplyResult::IgnoredStale) {
            continue;
        }
        result.changed |= changes_projection || matches!(outcome, ApplyResult::NeedsResync(_));
        if let Some(pane_id) = agent_pane_id {
            changed_agent_pane_ids.insert(pane_id);
        }
        if let ApplyResult::NeedsResync(reason) = outcome
            && result.resync_reason.is_none()
        {
            result.resync_reason = Some(reason);
        }
    }
    result.changed_agent_pane_ids = changed_agent_pane_ids.into_iter().collect();
    result.changed_agent_pane_ids.sort_unstable();
    result
}

/// Called by the typed event decoder with all events parsed from one transport
/// read. Rust applies the entire burst authoritatively before projecting once.
pub(crate) fn deliver_herdr_events(
    client_key: &str,
    events: Vec<HerdrEvent>,
) -> Option<Vec<HerdrEvent>> {
    let runtime = runtimes().read().get(client_key).and_then(Weak::upgrade);
    let Some(runtime) = runtime else {
        return Some(events);
    };
    let result = {
        let mut state = runtime.state.lock();
        if state.connection != HostConnectionState::Connected || state.event.is_none() {
            return None;
        }
        let result = apply_herdr_event_batch(&mut state, events);
        drop(state);
        result
    };
    if result.changed {
        emit_host_state(&runtime, result.changed_agent_pane_ids);
    }
    if let Some(reason) = result.resync_reason {
        schedule_state_resync(runtime, reason);
    }
    None
}

pub(crate) fn event_subscription_closed(client_key: &str, reason: String) -> bool {
    let runtime = runtimes().read().get(client_key).and_then(Weak::upgrade);
    let Some(runtime) = runtime else { return false };
    let state = runtime.state.lock();
    if state.event.is_none() || state.connection != HostConnectionState::Connected {
        return true;
    }
    drop(state);
    schedule_state_resync(
        runtime.clone(),
        format!("event subscription closed: {reason}"),
    );
    emit_host_state(&runtime, Vec::new());
    emit(HostRuntimeEvent::EventSubscriptionClosed {
        runtime_id: runtime.id.clone(),
        reason: reason.clone(),
    });
    schedule_event_retry(runtime, reason);
    true
}

pub(crate) fn terminal_bridge_closed(
    client_key: &str,
    terminal_id: &str,
    bridge_id: HerdrBridgeId,
    reason: String,
) -> bool {
    let runtime = runtimes().read().get(client_key).and_then(Weak::upgrade);
    let Some(runtime) = runtime else { return false };
    if runtime.state.lock().connection != HostConnectionState::Connected {
        return true;
    }
    schedule_terminal_retry(runtime, terminal_id.to_owned(), Some(bridge_id), reason);
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
    let state = RuntimeState::new(&config);
    let (cancellation, _) = watch::channel(0);
    let (status_tx, _) = watch::channel(state.status());
    let herdr = HerdrConnection::new(
        id.clone(),
        config.session_name.clone(),
        config.socket_path.clone(),
        config.cached_socket_path.clone(),
    );
    let inner = Arc::new(RuntimeInner {
        id: id.clone(),
        state: Mutex::new(state),
        agents: AgentSessionManager::new(id.clone(), herdr.clone()),
        operations: RemoteOperationManager::default(),
        herdr,
        jump_sessions: Mutex::new(Vec::new()),
        herdr_startup: AsyncMutex::new(()),
        config,
        cancellation,
        status_tx,
        terminal_settled: Notify::new(),
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
        self.inner.status_tx.borrow().clone()
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
            AgentTranscriptKind::OpenCode => {
                let (key, state) =
                    self.inner
                        .agents
                        .open_opencode(terminal_id, session_id, cache_blob)?;
                Ok(AgentSessionOpenResult { key, state })
            }
        }
    }

    pub fn bind_agent_session(
        &self,
        agent: AgentTranscriptKind,
        terminal_id: String,
        session_id: String,
    ) -> Result<AgentSessionOpenResult, AgentSessionError> {
        let (key, state) = match agent {
            AgentTranscriptKind::Codex => self.inner.agents.bind_codex(terminal_id, session_id)?,
            AgentTranscriptKind::OpenCode => {
                self.inner.agents.bind_opencode(terminal_id, session_id)?
            }
        };
        Ok(AgentSessionOpenResult { key, state })
    }

    pub fn start_agent_session(
        &self,
        terminal_id: String,
        key: String,
        cache_blob: Option<Vec<u8>>,
    ) -> Result<AgentTranscriptState, AgentSessionError> {
        self.inner
            .agents
            .start_bound(&terminal_id, &key, cache_blob)
    }

    pub fn agent_transcript(&self, key: String) -> Result<AgentTranscriptState, AgentSessionError> {
        self.inner.agents.state(&key).ok_or_else(|| {
            AgentSessionError::SessionClosed(format!("agent transcript session {key} is closed"))
        })
    }

    pub fn close_agent_session(&self, key: String) {
        self.inner.agents.close_session(&key);
    }

    pub fn close_agent_terminal(&self, terminal_id: String) -> Option<String> {
        self.inner.agents.close_terminal(&terminal_id)
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
        self.inner.herdr.resolved_socket_path()
    }

    pub async fn resolve_control_socket(&self) -> Result<String, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                inner
                    .herdr
                    .resolve_control_socket()
                    .await
                    .map_err(|error| HostRuntimeError::ControlConnectionFailure(error.to_string()))
            })
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
                let generation = {
                    let mut state = inner.state.lock();
                    if state.connection == HostConnectionState::Disconnected {
                        drop(state);
                        runtimes().write().remove(&inner.id);
                        return Ok(());
                    }
                    let epoch = state.disconnect();
                    let _ = inner.cancellation.send(epoch);
                    state.generation
                };
                invalidate_remote_operations(&inner, generation, "Host runtime disconnected");
                publish_lifecycle_status(&inner);
                emit_host_state(&inner, Vec::new());
                inner.terminal_settled.notify_waiters();
                inner.agents.disconnected(true, "Host runtime disconnected");
                close_herdr_event_subscription(inner.id.clone());
                close_all_herdr_terminal_bridges(inner.id.clone());
                let ssh = inner.herdr.clear(generation);
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
                publish_lifecycle_status(&inner);
                emit_host_state(&inner, Vec::new());
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
                let status_rx = inner.status_tx.subscribe();
                begin_reconnect(inner.clone(), reason, immediate);
                wait_for_reconnect(status_rx).await
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

    pub async fn create_tab_with_launch(
        &self,
        workspace_id: String,
        label: String,
        launch: HerdrTabLaunch,
    ) -> Result<HerdrTabLaunchResult, HerdrControlError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HerdrControlError::TransportDisconnected)?
            .spawn(create_tab_with_launch_inner(
                inner,
                workspace_id,
                label,
                launch,
            ))
            .await
            .map_err(|error| {
                HerdrControlError::RequestCancelled(format!("host tab launch task failed: {error}"))
            })?
    }

    pub async fn submit_pastes(
        &self,
        pane_id: String,
        parts: Vec<String>,
    ) -> Result<(), HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(submit_pastes_inner(inner, pane_id, parts))
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!(
                    "pane submission task failed: {error}"
                ))
            })?
    }

    pub async fn start_herdr_server(&self) -> Result<(), HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(start_herdr_server_inner(inner))
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!(
                    "Herdr server startup task failed: {error}"
                ))
            })?
    }

    pub async fn agent_integration_status(
        &self,
        kind: HerdrAgentKind,
    ) -> Result<AgentIntegrationStatus, HostRuntimeError> {
        let command = integration_status_command(&self.inner.config.herdr_command);
        let output = self.execute(command).await?;
        Ok(parse_agent_integration_status(&output, kind))
    }

    pub async fn install_agent_integration(
        &self,
        kind: HerdrAgentKind,
    ) -> Result<HerdrIntegrationInstallResult, HerdrControlError> {
        match self
            .control_request(HerdrControlRequest::IntegrationInstall { kind })
            .await?
        {
            HerdrControlResult::IntegrationInstalled { install } if install.kind == kind => {
                Ok(install)
            }
            HerdrControlResult::IntegrationInstalled { install } => {
                Err(HerdrControlError::UnsupportedResponse(format!(
                    "integration.install returned {:?} for requested {:?}",
                    install.kind, kind
                )))
            }
            _ => Err(HerdrControlError::UnsupportedResponse(
                "integration.install returned a non-integration result".to_owned(),
            )),
        }
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

    #[allow(
        clippy::too_many_arguments,
        reason = "the native terminal API keeps geometry fields explicit for UniFFI callers"
    )]
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
                    let open_state = if let Some(terminal) = state.terminals.get_mut(&terminal_id) {
                        terminal.takeover = takeover;
                        terminal.columns = columns.max(20);
                        terminal.rows = rows.max(8);
                        terminal.cell_width_px = cell_width_px;
                        terminal.cell_height_px = cell_height_px;
                        if terminal.state == HostTerminalState::Attached {
                            let bridge_is_live = terminal.bridge_id.is_some_and(|bridge_id| {
                                active_herdr_terminal_bridge_id(&inner.id, &terminal_id)
                                    == Some(bridge_id)
                            });
                            if bridge_is_live {
                                return Ok(());
                            }
                            terminal.bridge_id = None;
                        }
                        if matches!(
                            terminal.state,
                            HostTerminalState::Opening | HostTerminalState::Restoring
                        ) {
                            (terminal.operation_epoch, true)
                        } else {
                            terminal.operation_epoch = terminal.operation_epoch.wrapping_add(1);
                            terminal.state = HostTerminalState::Opening;
                            terminal.reconnect_attempt = 0;
                            terminal.retry_running = true;
                            terminal.bridge_id = None;
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
                                reconnect_attempt: 0,
                                retry_running: true,
                                bridge_id: None,
                            },
                        );
                        (1, false)
                    };
                    drop(state);
                    open_state
                };
                if wait_for_existing {
                    return wait_for_terminal_open(&inner, &terminal_id, operation_epoch).await;
                }
                emit(HostRuntimeEvent::TerminalStateChanged {
                    runtime_id: inner.id.clone(),
                    terminal_id: terminal_id.clone(),
                    state: HostTerminalState::Opening,
                    reconnect_attempt: 0,
                    retrying: true,
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
        if live_terminal_bridge_id(&self.inner, &terminal_id).is_none() {
            let reason = format!("terminal {terminal_id} has no live bridge");
            schedule_terminal_retry(
                self.inner.clone(),
                terminal_id.clone(),
                None,
                reason.clone(),
            );
            return Err(HostRuntimeError::TerminalUnavailable(format!(
                "terminal {terminal_id} is unavailable: {reason}"
            )));
        }
        herdr_terminal_input(self.inner.id.clone(), terminal_id.clone(), text).map_err(|error| {
            let reason = error.to_string();
            schedule_terminal_retry(self.inner.clone(), terminal_id, None, reason.clone());
            HostRuntimeError::TerminalUnavailable(reason)
        })
    }

    pub fn resize_terminal(
        &self,
        terminal_id: String,
        columns: u32,
        rows: u32,
        cell_width_px: u32,
        cell_height_px: u32,
    ) -> Result<(), HostRuntimeError> {
        let attached = {
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
            let attached = terminal.state == HostTerminalState::Attached;
            drop(state);
            attached
        };
        if !attached {
            return Ok(());
        }
        if live_terminal_bridge_id(&self.inner, &terminal_id).is_none() {
            let reason = format!("terminal {terminal_id} has no live bridge while resizing");
            schedule_terminal_retry(self.inner.clone(), terminal_id, None, reason.clone());
            return Err(HostRuntimeError::TerminalUnavailable(reason));
        }
        herdr_terminal_resize(
            self.inner.id.clone(),
            terminal_id.clone(),
            columns.max(20),
            rows.max(8),
            cell_width_px,
            cell_height_px,
        )
        .map_err(|error| {
            let reason = error.to_string();
            schedule_terminal_retry(self.inner.clone(), terminal_id, None, reason.clone());
            HostRuntimeError::TerminalUnavailable(reason)
        })
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
        if live_terminal_bridge_id(&self.inner, &terminal_id).is_none() {
            let reason = format!("terminal {terminal_id} has no live bridge while scrolling");
            schedule_terminal_retry(self.inner.clone(), terminal_id, None, reason.clone());
            return Err(HostRuntimeError::TerminalUnavailable(reason));
        }
        herdr_terminal_scroll(
            self.inner.id.clone(),
            terminal_id.clone(),
            up,
            lines,
            column,
            row,
            modifiers,
        )
        .map_err(|error| {
            let reason = error.to_string();
            schedule_terminal_retry(self.inner.clone(), terminal_id, None, reason.clone());
            HostRuntimeError::TerminalUnavailable(reason)
        })
    }

    pub fn close_terminal(&self, terminal_id: String) {
        close_terminal_intent(&self.inner, terminal_id);
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
            self.inner.agents.close_terminal(&terminal_id);
            emit(HostRuntimeEvent::TerminalStateChanged {
                runtime_id: self.inner.id.clone(),
                terminal_id,
                state: HostTerminalState::Closed,
                reconnect_attempt: 0,
                retrying: false,
                error: None,
            });
        }
        self.inner.terminal_settled.notify_waiters();
    }

    pub fn has_terminal(&self, terminal_id: String) -> bool {
        live_terminal_bridge_id(&self.inner, &terminal_id).is_some()
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

    pub async fn measure_host_latency(&self) -> Result<HostLatencyMeasurement, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let started_at = Instant::now();
                let result = match current_ssh(&inner) {
                    Ok(ssh) => ssh.latency_ms().await.map_err(HostRuntimeError::from),
                    Err(error) => Err(error),
                };
                match result {
                    Ok(ssh_rtt_ms) => {
                        let total_ms = elapsed_ms(started_at);
                        if total_ms >= SLOW_RUNTIME_DIAGNOSTIC_MS {
                            emit_diagnostic(
                                &inner,
                                RuntimeDiagnosticOperation::HostLatencyProbe,
                                started_at,
                                Some(ssh_rtt_ms),
                                None,
                                None,
                            );
                        }
                        Ok(HostLatencyMeasurement {
                            ssh_rtt_ms,
                            total_ms,
                            runtime_overhead_ms: (total_ms - ssh_rtt_ms).max(0.0),
                        })
                    }
                    Err(error) => {
                        emit_diagnostic(
                            &inner,
                            RuntimeDiagnosticOperation::HostLatencyProbe,
                            started_at,
                            None,
                            None,
                            Some(error.to_string()),
                        );
                        Err(error)
                    }
                }
            })
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!("SSH latency task failed: {error}"))
            })?
    }

    pub async fn list_directory(
        &self,
        path: Option<String>,
    ) -> Result<RemoteDirectoryListing, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let generation = current_generation(&inner)?;
                let path = resolved_remote_path(&inner, path.as_deref()).await?;
                let entries = current_ssh(&inner)?.sftp_list(&path).await?;
                validate_generation(&inner, generation)?;
                let mut entries = entries
                    .into_iter()
                    .filter_map(|entry| {
                        let name = entry.filename.trim_end_matches('/').to_owned();
                        if name.is_empty() || matches!(name.as_str(), "." | "..") {
                            return None;
                        }
                        let entry_path = join_remote_path(&path, &name).ok()?;
                        let kind = if entry.metadata.is_directory {
                            RemoteFileKind::Directory
                        } else if entry.metadata.is_regular {
                            RemoteFileKind::File
                        } else if entry.metadata.is_symlink {
                            RemoteFileKind::Symlink
                        } else {
                            RemoteFileKind::Other
                        };
                        Some(RemoteFileEntry {
                            name,
                            path: entry_path,
                            kind,
                            size: entry.metadata.size,
                            modified_at: entry.metadata.modified_at,
                            permissions: entry.metadata.permissions,
                        })
                    })
                    .collect::<Vec<_>>();
                entries.sort_by(|left, right| {
                    let left_directory = left.kind == RemoteFileKind::Directory;
                    let right_directory = right.kind == RemoteFileKind::Directory;
                    right_directory.cmp(&left_directory).then_with(|| {
                        left.name
                            .to_lowercase()
                            .cmp(&right.name.to_lowercase())
                            .then(left.name.cmp(&right.name))
                    })
                });
                Ok(RemoteDirectoryListing { path, entries })
            })
            .await
            .map_err(|error| {
                HostRuntimeError::RemoteFileFailure(format!(
                    "remote directory task failed: {error}"
                ))
            })?
    }

    pub async fn stat_remote_path(
        &self,
        path: String,
    ) -> Result<RemoteFileEntry, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let generation = current_generation(&inner)?;
                let path = resolved_remote_path(&inner, Some(&path)).await?;
                let metadata = current_ssh(&inner)?.sftp_stat(&path).await?;
                validate_generation(&inner, generation)?;
                let name = remote_filename(&path).unwrap_or_else(|_| "/".to_owned());
                let kind = if metadata.is_directory {
                    RemoteFileKind::Directory
                } else if metadata.is_regular {
                    RemoteFileKind::File
                } else if metadata.is_symlink {
                    RemoteFileKind::Symlink
                } else {
                    RemoteFileKind::Other
                };
                Ok(RemoteFileEntry {
                    name,
                    path,
                    kind,
                    size: metadata.size,
                    modified_at: metadata.modified_at,
                    permissions: metadata.permissions,
                })
            })
            .await
            .map_err(|error| {
                HostRuntimeError::RemoteFileFailure(format!("remote stat task failed: {error}"))
            })?
    }

    pub async fn read_remote_text(
        &self,
        path: String,
        max_bytes: Option<u64>,
    ) -> Result<String, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let generation = current_generation(&inner)?;
                let path = resolved_remote_path(&inner, Some(&path)).await?;
                let limit = max_bytes
                    .unwrap_or(REMOTE_TEXT_MAX_BYTES)
                    .clamp(1, REMOTE_TEXT_MAX_BYTES);
                let bytes = current_ssh(&inner)?.sftp_read_limited(&path, limit).await?;
                validate_generation(&inner, generation)?;
                String::from_utf8(bytes).map_err(|_| {
                    HostRuntimeError::RemoteFileFailure(
                        "remote file is not valid UTF-8 text".to_owned(),
                    )
                })
            })
            .await
            .map_err(|error| {
                HostRuntimeError::RemoteFileFailure(format!("remote text task failed: {error}"))
            })?
    }

    pub async fn create_remote_directory(&self, path: String) -> Result<(), HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let generation = current_generation(&inner)?;
                let path = resolved_remote_path(&inner, Some(&path)).await?;
                current_ssh(&inner)?.sftp_create_dir_all(&path).await?;
                validate_generation(&inner, generation)
            })
            .await
            .map_err(|error| {
                HostRuntimeError::RemoteFileFailure(format!("remote mkdir task failed: {error}"))
            })?
    }

    pub async fn rename_remote_path(
        &self,
        from: String,
        to: String,
    ) -> Result<(), HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let generation = current_generation(&inner)?;
                let from = resolved_remote_path(&inner, Some(&from)).await?;
                let to = resolved_remote_path(&inner, Some(&to)).await?;
                current_ssh(&inner)?.sftp_rename(&from, &to).await?;
                validate_generation(&inner, generation)
            })
            .await
            .map_err(|error| {
                HostRuntimeError::RemoteFileFailure(format!("remote rename task failed: {error}"))
            })?
    }

    pub async fn remove_remote_path(
        &self,
        path: String,
        directory: bool,
    ) -> Result<(), HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let generation = current_generation(&inner)?;
                let path = resolved_remote_path(&inner, Some(&path)).await?;
                current_ssh(&inner)?.sftp_remove(&path, directory).await?;
                validate_generation(&inner, generation)
            })
            .await
            .map_err(|error| {
                HostRuntimeError::RemoteFileFailure(format!("remote remove task failed: {error}"))
            })?
    }

    pub fn start_upload(
        &self,
        local_path: String,
        remote_directory: String,
    ) -> Result<String, HostRuntimeError> {
        let generation = current_generation(&self.inner)?;
        let ssh = current_ssh(&self.inner)?;
        let (transfer_id, mut cancel, _) = self
            .inner
            .operations
            .begin_transfer(generation)
            .map_err(HostRuntimeError::TransferFailure)?;
        let id = transfer_id.clone();
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let result = async {
                    let filename = std::path::Path::new(&local_path)
                        .file_name()
                        .and_then(|value| value.to_str())
                        .ok_or_else(|| "local upload path has no UTF-8 filename".to_owned())?;
                    let home = transfer_setup_step(&mut cancel, ssh.remote_home()).await?;
                    let directory = normalize_remote_path(Some(&remote_directory), home.trim())?;
                    let remote_path = join_remote_path(&directory, filename)?;
                    let progress_inner = inner.clone();
                    let progress_id = id.clone();
                    let progress = Arc::new(move |bytes, total| {
                        update_transfer_progress(&progress_inner, &progress_id, bytes, total);
                    });
                    ssh.transfer_upload(&local_path, &remote_path, cancel, progress)
                        .await
                        .map_err(|error| error.to_string())?;
                    Ok(TransferResult {
                        transfer_id: id.clone(),
                        local_path: Some(local_path),
                        remote_path: Some(remote_path),
                    })
                }
                .await;
                finish_transfer(&inner, &id, generation, result);
            });
        Ok(transfer_id)
    }

    pub fn start_attachment_upload(&self, local_path: String) -> Result<String, HostRuntimeError> {
        let generation = current_generation(&self.inner)?;
        let ssh = current_ssh(&self.inner)?;
        let (transfer_id, mut cancel, _) = self
            .inner
            .operations
            .begin_transfer(generation)
            .map_err(HostRuntimeError::TransferFailure)?;
        let id = transfer_id.clone();
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let result = async {
                    let home = crate::remote_ops::normalize_absolute(
                        transfer_setup_step(&mut cancel, ssh.remote_home())
                            .await?
                            .trim(),
                    )?;
                    let upload_directory = join_remote_path(&home, ".whip/uploads")?;
                    transfer_setup_step(&mut cancel, ssh.sftp_create_dir_all(&upload_directory))
                        .await?;
                    let filename = attachment_filename(&local_path)?;
                    let remote_path = join_remote_path(&upload_directory, &filename)?;
                    let progress_inner = inner.clone();
                    let progress_id = id.clone();
                    let progress = Arc::new(move |bytes, total| {
                        update_transfer_progress(&progress_inner, &progress_id, bytes, total);
                    });
                    ssh.transfer_upload(&local_path, &remote_path, cancel, progress)
                        .await
                        .map_err(|error| error.to_string())?;
                    Ok(TransferResult {
                        transfer_id: id.clone(),
                        local_path: Some(local_path),
                        remote_path: Some(remote_path),
                    })
                }
                .await;
                finish_transfer(&inner, &id, generation, result);
            });
        Ok(transfer_id)
    }

    pub fn start_download(
        &self,
        remote_path: String,
        local_directory: String,
    ) -> Result<String, HostRuntimeError> {
        let generation = current_generation(&self.inner)?;
        let ssh = current_ssh(&self.inner)?;
        let (transfer_id, mut cancel, _) = self
            .inner
            .operations
            .begin_transfer(generation)
            .map_err(HostRuntimeError::TransferFailure)?;
        let id = transfer_id.clone();
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let result = async {
                    let home = transfer_setup_step(&mut cancel, ssh.remote_home()).await?;
                    let remote_path = normalize_remote_path(Some(&remote_path), home.trim())?;
                    let filename = remote_filename(&remote_path)?;
                    let local_path = std::path::Path::new(&local_directory)
                        .join(filename)
                        .to_str()
                        .ok_or_else(|| "local download path is not UTF-8".to_owned())?
                        .to_owned();
                    let progress_inner = inner.clone();
                    let progress_id = id.clone();
                    let progress = Arc::new(move |bytes, total| {
                        update_transfer_progress(&progress_inner, &progress_id, bytes, total);
                    });
                    ssh.transfer_download(&remote_path, &local_path, cancel, progress)
                        .await
                        .map_err(|error| error.to_string())?;
                    Ok(TransferResult {
                        transfer_id: id.clone(),
                        local_path: Some(local_path),
                        remote_path: Some(remote_path),
                    })
                }
                .await;
                finish_transfer(&inner, &id, generation, result);
            });
        Ok(transfer_id)
    }

    pub fn transfer_progress(&self, transfer_id: String) -> Option<TransferProgress> {
        self.inner
            .operations
            .transfers
            .lock()
            .get(&transfer_id)
            .map(|slot| slot.progress.clone())
    }

    pub async fn await_transfer(
        &self,
        transfer_id: String,
    ) -> Result<TransferResult, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                loop {
                    let pending = {
                        let mut transfers = inner.operations.transfers.lock();
                        let slot = transfers.get(&transfer_id).ok_or_else(|| {
                            HostRuntimeError::TransferFailure(format!(
                                "unknown transfer {transfer_id}"
                            ))
                        })?;
                        if let Some(result) = &slot.result {
                            let result = result.clone();
                            let state = slot.progress.state;
                            transfers.remove(&transfer_id);
                            return match result {
                                Ok(result) => Ok(result),
                                Err(error) if state == TransferState::Cancelled => {
                                    Err(HostRuntimeError::TransferCancelled(error))
                                }
                                Err(error) => Err(HostRuntimeError::TransferFailure(error)),
                            };
                        }
                        let notify = slot.notify.clone();
                        drop(transfers);
                        notify
                    };
                    pending.notified().await;
                }
            })
            .await
            .map_err(|error| {
                HostRuntimeError::TransferFailure(format!("transfer wait task failed: {error}"))
            })?
    }

    pub fn cancel_transfer(&self, transfer_id: String) -> bool {
        let cancelled = self.inner.operations.cancel_transfer(&transfer_id);
        if cancelled && let Some(progress) = self.transfer_progress(transfer_id) {
            emit(HostRuntimeEvent::TransferProgressChanged {
                runtime_id: self.inner.id.clone(),
                progress,
            });
        }
        cancelled
    }

    pub async fn discover_git_repository(
        &self,
        path: String,
    ) -> Result<Option<GitRepository>, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let path = resolved_remote_path(&inner, Some(&path)).await?;
                let output =
                    execute_generation_checked(&inner, &git_repository_command(&path)).await?;
                if output.stdout_truncated {
                    return Err(HostRuntimeError::GitFailure(
                        "Git repository output exceeded the command limit".to_owned(),
                    ));
                }
                parse_git_repository(std::str::from_utf8(&output.stdout).map_err(|_| {
                    HostRuntimeError::GitFailure("Git repository output was not UTF-8".to_owned())
                })?)
                .map_err(HostRuntimeError::GitFailure)
            })
            .await
            .map_err(|error| {
                HostRuntimeError::GitFailure(format!("Git discovery task failed: {error}"))
            })?
    }

    pub async fn git_status(&self, root: String) -> Result<Vec<GitStatusEntry>, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let root = resolved_remote_path(&inner, Some(&root)).await?;
                let output = execute_generation_checked(&inner, &git_status_command(&root)).await?;
                if output.exit_status != Some(0) {
                    return Err(HostRuntimeError::GitFailure(command_failure(
                        "git status",
                        &output,
                    )));
                }
                if output.stdout_truncated {
                    return Err(HostRuntimeError::GitFailure(
                        "Git status exceeded the 8 MiB command limit".to_owned(),
                    ));
                }
                parse_git_status(&output.stdout, &root).map_err(HostRuntimeError::GitFailure)
            })
            .await
            .map_err(|error| {
                HostRuntimeError::GitFailure(format!("Git status task failed: {error}"))
            })?
    }

    pub async fn git_diff(
        &self,
        repository: GitRepository,
        status: GitStatusEntry,
    ) -> Result<GitDiff, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let command =
                    git_diff_command(&repository, &status).map_err(HostRuntimeError::GitFailure)?;
                let output = execute_generation_checked(&inner, &command).await?;
                if output.exit_status.is_some_and(|status| status != 0) {
                    return Err(HostRuntimeError::GitFailure(command_failure(
                        "git diff", &output,
                    )));
                }
                parse_git_diff(&output.stdout).map_err(HostRuntimeError::GitFailure)
            })
            .await
            .map_err(|error| {
                HostRuntimeError::GitFailure(format!("Git diff task failed: {error}"))
            })?
    }

    pub async fn start_web_preview(
        &self,
        remote_url: String,
    ) -> Result<PreviewInfo, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let generation = current_generation(&inner)?;
                if inner.operations.previews.lock().len() >= MAX_ACTIVE_PREVIEWS {
                    return Err(HostRuntimeError::PreviewFailure(format!(
                        "at most {MAX_ACTIVE_PREVIEWS} previews may be open at once"
                    )));
                }
                let id = inner.operations.next_id("preview");
                let ssh = current_ssh(&inner)?;
                let (info, preview) = crate::remote_preview::start_web_preview(
                    ssh.clone(),
                    id.clone(),
                    generation,
                    &remote_url,
                )
                .await?;
                if let Err(error_preview) = register_preview(&inner, id, generation, preview) {
                    let (error, preview) = *error_preview;
                    crate::remote_preview::stop_preview(&ssh, preview.resource).await;
                    return Err(error);
                }
                Ok(info)
            })
            .await
            .map_err(|error| {
                HostRuntimeError::PreviewFailure(format!("web preview task failed: {error}"))
            })?
    }

    pub async fn start_html_preview(
        &self,
        remote_path: String,
    ) -> Result<PreviewInfo, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(start_path_preview_inner(inner, remote_path, true))
            .await
            .map_err(|error| {
                HostRuntimeError::PreviewFailure(format!("HTML preview task failed: {error}"))
            })?
    }

    pub async fn start_remote_file_preview(
        &self,
        remote_path: String,
    ) -> Result<PreviewInfo, HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(start_path_preview_inner(inner, remote_path, false))
            .await
            .map_err(|error| {
                HostRuntimeError::PreviewFailure(format!(
                    "remote file preview task failed: {error}"
                ))
            })?
    }

    pub async fn stop_preview(&self, preview_id: String) -> Result<(), HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(async move {
                let preview = inner.operations.previews.lock().remove(&preview_id);
                if let Some(preview) = preview {
                    if let Ok(ssh) = current_ssh(&inner) {
                        crate::remote_preview::stop_preview(&ssh, preview.resource).await;
                    }
                    emit(HostRuntimeEvent::PreviewStateChanged {
                        runtime_id: inner.id.clone(),
                        preview_id,
                        state: PreviewState::Stopped,
                        error: None,
                    });
                }
                Ok(())
            })
            .await
            .map_err(|error| {
                HostRuntimeError::PreviewFailure(format!("preview stop task failed: {error}"))
            })?
    }
}

impl Drop for HostRuntime {
    fn drop(&mut self) {
        if Arc::strong_count(&self.inner) != 1 {
            return;
        }
        let inner = self.inner.clone();
        runtimes().write().remove(&inner.id);
        let (epoch, generation) = {
            let mut state = inner.state.lock();
            let generation = state.generation;
            (state.disconnect(), generation)
        };
        let _ = inner.cancellation.send(epoch);
        invalidate_remote_operations(&inner, generation, "Host runtime dropped");
        inner.agents.disconnected(true, "Host runtime dropped");
        close_herdr_event_subscription(inner.id.clone());
        close_all_herdr_terminal_bridges(inner.id.clone());
        let ssh = inner.herdr.clear(generation);
        if let Ok(runtime) = crate::runtime() {
            runtime.spawn(async move {
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
    use crate::herdr_api::{
        HerdrAgentStatus, HerdrPaneInfo, HerdrSessionSnapshot, HerdrTabInfo, HerdrWorkspaceInfo,
    };

    static EVENT_SINK_TEST_LOCK: Mutex<()> = Mutex::new(());

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

    #[derive(Default)]
    struct RecordingRuntimeSink {
        events: Mutex<Vec<HostRuntimeEvent>>,
    }

    impl HostRuntimeEventSink for RecordingRuntimeSink {
        fn event(&self, event: HostRuntimeEvent) {
            self.events.lock().push(event);
        }
    }

    struct PanickingRuntimeSink;

    impl HostRuntimeEventSink for PanickingRuntimeSink {
        fn event(&self, _event: HostRuntimeEvent) {
            panic!("diagnostic listener failed");
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
            herdr_command: "herdr".to_owned(),
            socket_path: None,
            cached_socket_path: None,
        }
    }

    fn runtime_inner_with_state(
        id: &str,
        runtime_config: HostRuntimeConfig,
        state: RuntimeState,
    ) -> Arc<RuntimeInner> {
        let (cancellation, _) = watch::channel(0);
        let (status_tx, _) = watch::channel(state.status());
        let herdr = HerdrConnection::new(
            id.to_owned(),
            runtime_config.session_name.clone(),
            runtime_config.socket_path.clone(),
            runtime_config.cached_socket_path.clone(),
        );
        Arc::new(RuntimeInner {
            id: id.to_owned(),
            config: runtime_config,
            state: Mutex::new(state),
            agents: AgentSessionManager::new(id.to_owned(), herdr.clone()),
            operations: RemoteOperationManager::default(),
            herdr,
            jump_sessions: Mutex::new(Vec::new()),
            herdr_startup: AsyncMutex::new(()),
            cancellation,
            status_tx,
            terminal_settled: Notify::new(),
        })
    }

    fn connected_runtime_inner(id: &str) -> Arc<RuntimeInner> {
        let runtime_config = config();
        let mut state = RuntimeState::new(&runtime_config);
        state.connection = HostConnectionState::Connected;
        state.generation = 1;
        state.host_state.connection_installed(1);
        state.event = Some(EventSubscriptionRuntime {
            pane_ids: Vec::new(),
            operation_epoch: 1,
            retry_running: false,
        });
        runtime_inner_with_state(id, runtime_config, state)
    }

    fn empty_ready_snapshot() -> ReadyHerdrSnapshot {
        let mut snapshot = batch_test_snapshot();
        snapshot.protocol = MAX_PROTOCOL;
        snapshot.focused_workspace_id = None;
        snapshot.focused_tab_id = None;
        snapshot.focused_pane_id = None;
        snapshot.agents.clear();
        snapshot.workspaces.clear();
        snapshot.tabs.clear();
        snapshot.panes.clear();
        snapshot.layouts.clear();
        ReadyHerdrSnapshot { snapshot }
    }

    #[test]
    fn managed_agent_names_are_native_owned_and_stable() {
        assert_eq!(
            managed_agent_name("  42 Review / Fix  ", HerdrAgentKind::Codex, 2.0),
            "review-fix"
        );
        assert_eq!(
            managed_agent_name("---", HerdrAgentKind::OpenCode, 3.0),
            "opencode-3"
        );
        assert_eq!(
            managed_agent_name(
                "A very long tab label whose agent name must be bounded",
                HerdrAgentKind::Claude,
                1.0,
            ),
            "a-very-long-tab-label-whose-agen"
        );
    }

    #[test]
    fn integration_status_command_and_parser_are_native_owned() {
        let command = integration_status_command("/opt/herdr current/herdr");
        assert!(command.contains("integration status"));
        assert!(command.contains("/opt/herdr current/herdr"));
        assert_eq!(
            parse_agent_integration_status(
                "claude: not installed\ncodex: current (v2)\n",
                HerdrAgentKind::Codex,
            ),
            AgentIntegrationStatus::Current
        );
        assert_eq!(
            parse_agent_integration_status(
                "opencode: needs repair (/tmp/config)\n",
                HerdrAgentKind::OpenCode,
            ),
            AgentIntegrationStatus::NeedsRepair
        );
        assert_eq!(
            parse_agent_integration_status("older output", HerdrAgentKind::Codex),
            AgentIntegrationStatus::Unknown
        );
    }

    #[test]
    fn server_start_command_is_native_owned_and_supports_profile_values() {
        let command = start_herdr_server_command("/opt/herdr current/herdr", "team's session");
        assert!(command.starts_with("exec /bin/sh -c "));
        assert!(command.contains("nohup"));
        assert!(command.contains("/opt/herdr current/herdr"));
        assert!(command.contains("team"));
        assert!(command.contains("server"));
        assert!(command.contains("/tmp/whip-herdr-server.log"));
    }

    #[test]
    fn readiness_retries_transient_socket_failures_until_snapshot_is_ready() {
        crate::runtime().unwrap().block_on(async {
            let attempts = Arc::new(AtomicU64::new(0));
            let attempts_for_probe = attempts.clone();
            let mut ready = Some(empty_ready_snapshot());
            let result = poll_herdr_readiness(
                Instant::now() + Duration::from_millis(100),
                Duration::from_millis(1),
                Duration::from_millis(2),
                move || {
                    let attempt = attempts_for_probe.fetch_add(1, Ordering::SeqCst) + 1;
                    std::future::ready(if attempt < 3 {
                        Err(HerdrReadinessProbeError::Retryable(
                            "socket not ready yet".to_owned(),
                        ))
                    } else {
                        Ok(ready.take().expect("ready result is returned once"))
                    })
                },
            )
            .await;

            assert!(result.is_ok());
            assert_eq!(attempts.load(Ordering::SeqCst), 3);
        });
    }

    #[test]
    fn readiness_deadline_preserves_a_typed_timeout_reason() {
        crate::runtime().unwrap().block_on(async {
            let result = poll_herdr_readiness(
                Instant::now() + Duration::from_millis(10),
                Duration::from_millis(2),
                Duration::from_millis(4),
                || {
                    std::future::ready(Err(HerdrReadinessProbeError::Retryable(
                        "socket not ready yet".to_owned(),
                    )))
                },
            )
            .await;

            assert!(matches!(
                result,
                Err(HerdrReadinessPollError::Timeout(message))
                    if message == "socket not ready yet"
            ));
            assert!(matches!(
                herdr_readiness_timeout("socket not ready yet"),
                HostRuntimeError::HerdrReadinessTimeout {
                    timeout_ms: 12_000,
                    last_error,
                } if last_error == "socket not ready yet"
            ));
        });
    }

    #[test]
    fn unsupported_herdr_protocol_is_permanent_instead_of_timing_out() {
        assert!(matches!(
            validate_herdr_protocol(MIN_PROTOCOL - 1),
            Err(HostRuntimeError::HerdrProtocolMismatch { expected, received })
                if expected == herdr_protocol_label() && received == MIN_PROTOCOL - 1
        ));
        assert!(validate_herdr_protocol(MIN_PROTOCOL).is_ok());
        assert!(validate_herdr_protocol(MAX_PROTOCOL).is_ok());
    }

    #[test]
    fn ssh_disconnect_during_readiness_is_not_retried_as_socket_startup() {
        let inner = connected_runtime_inner("readiness-disconnect-test");
        let error = readiness_probe_error(
            &inner,
            1,
            HerdrControlError::TransportDisconnected("channel closed".to_owned()),
        );
        assert!(matches!(
            error,
            HerdrReadinessProbeError::Permanent(HostRuntimeError::RuntimeDisconnected(_))
        ));
    }

    #[test]
    fn stale_startup_snapshot_cannot_install_into_a_replacement_generation() {
        crate::runtime().unwrap().block_on(async {
            let inner = connected_runtime_inner("stale-startup-test");
            let (_, token) = begin_host_state_sync(&inner);
            {
                let mut state = inner.state.lock();
                state.generation = 2;
                state.host_state.connection_installed(2);
            }

            let result =
                complete_herdr_startup_sync(inner.clone(), 1, token, empty_ready_snapshot()).await;

            assert!(matches!(result, Err(HostRuntimeError::StaleOperation(_))));
            assert!(
                inner
                    .state
                    .lock()
                    .host_state
                    .projection()
                    .snapshot
                    .is_none()
            );
        });
    }

    #[test]
    fn startup_success_installs_authoritative_host_state_and_emits_it() {
        let _guard = EVENT_SINK_TEST_LOCK.lock();
        crate::runtime().unwrap().block_on(async {
            let inner = connected_runtime_inner("startup-state-test");
            let sink = Arc::new(RecordingRuntimeSink::default());
            set_host_runtime_event_sink(sink.clone());
            let (_, token) = begin_host_state_sync(&inner);

            complete_herdr_startup_sync(inner.clone(), 1, token, empty_ready_snapshot())
                .await
                .unwrap();

            clear_host_runtime_event_sink();
            let state = inner.state.lock().host_state.projection();
            assert!(state.snapshot.is_some());
            assert_eq!(inner.state.lock().protocol, Some(MAX_PROTOCOL));
            assert!(sink.events.lock().iter().any(|event| matches!(
                event,
                HostRuntimeEvent::HostStateChanged { state, .. } if state.snapshot.is_some()
            )));
        });
    }

    async fn simulated_serialized_start(
        inner: Arc<RuntimeInner>,
        ready: Arc<AtomicBool>,
        launches: Arc<AtomicU64>,
    ) {
        let _startup = inner.herdr_startup.lock().await;
        if ready.load(Ordering::SeqCst) {
            return;
        }
        launches.fetch_add(1, Ordering::SeqCst);
        tokio::task::yield_now().await;
        ready.store(true, Ordering::SeqCst);
    }

    #[test]
    fn already_ready_and_duplicate_start_requests_do_not_duplicate_launches() {
        crate::runtime().unwrap().block_on(async {
            let inner = connected_runtime_inner("duplicate-start-test");
            let ready = Arc::new(AtomicBool::new(false));
            let launches = Arc::new(AtomicU64::new(0));
            tokio::join!(
                simulated_serialized_start(inner.clone(), ready.clone(), launches.clone()),
                simulated_serialized_start(inner.clone(), ready.clone(), launches.clone()),
            );
            assert_eq!(launches.load(Ordering::SeqCst), 1);

            simulated_serialized_start(inner, ready, launches.clone()).await;
            assert_eq!(launches.load(Ordering::SeqCst), 1);
        });
    }

    #[test]
    fn typed_launch_intent_selects_exactly_one_native_second_step() {
        let snapshot = batch_test_snapshot();
        let tab = &snapshot.tabs[0];
        let root_pane = &snapshot.panes[0];

        assert!(launch_request(tab, root_pane, HerdrTabLaunch::Shell).is_none());
        assert!(matches!(
            launch_request(
                tab,
                root_pane,
                HerdrTabLaunch::Agent {
                    kind: HerdrAgentKind::Codex,
                    args: Vec::new(),
                },
            ),
            Some((
                HerdrTabLaunchStage::AgentStart,
                HerdrControlRequest::AgentStart {
                    kind: HerdrAgentKind::Codex,
                    ..
                }
            ))
        ));
        assert!(matches!(
            launch_request(
                tab,
                root_pane,
                HerdrTabLaunch::Agent {
                    kind: HerdrAgentKind::OpenCode,
                    args: Vec::new(),
                },
            ),
            Some((
                HerdrTabLaunchStage::AgentStart,
                HerdrControlRequest::AgentStart {
                    kind: HerdrAgentKind::OpenCode,
                    ..
                }
            ))
        ));
        assert_eq!(
            launch_request(
                tab,
                root_pane,
                HerdrTabLaunch::Command {
                    command: "echo codex is installed".to_owned(),
                },
            ),
            Some((
                HerdrTabLaunchStage::CommandInput,
                HerdrControlRequest::PaneSendInput {
                    pane_id: "pane-1".to_owned(),
                    text: "echo codex is installed".to_owned(),
                    keys: vec!["enter".to_owned()],
                }
            ))
        );
    }

    #[test]
    fn rust_interprets_direct_agent_commands_without_consuming_shell_syntax() {
        assert_eq!(
            normalize_tab_launch(HerdrTabLaunch::Command {
                command: " opencode --model \"current model\" ".to_owned(),
            }),
            Ok(HerdrTabLaunch::Agent {
                kind: HerdrAgentKind::OpenCode,
                args: vec!["--model".to_owned(), "current model".to_owned()],
            })
        );
        assert_eq!(
            normalize_tab_launch(HerdrTabLaunch::Command {
                command: "codex --profile work".to_owned(),
            }),
            Ok(HerdrTabLaunch::Agent {
                kind: HerdrAgentKind::Codex,
                args: vec!["--profile".to_owned(), "work".to_owned()],
            })
        );
        for command in [
            "opencode --model \"$MODEL\"",
            "opencode && echo done",
            "echo codex is installed",
            "opencode --model \"unterminated",
            "/usr/bin/codex foo",
            "env FOO=bar codex foo",
            "command codex foo",
            "FOO=x codex foo",
        ] {
            assert_eq!(
                normalize_tab_launch(HerdrTabLaunch::Command {
                    command: command.to_owned(),
                }),
                Ok(HerdrTabLaunch::Command {
                    command: command.to_owned(),
                })
            );
        }
    }

    #[test]
    fn pane_submission_sequence_is_one_semantic_native_operation() {
        let requests = pane_submission_requests(
            "pane-1".to_owned(),
            vec![
                "review".to_owned(),
                String::new(),
                "/tmp/image.png".to_owned(),
            ],
        );
        assert_eq!(requests.len(), 3);
        assert!(matches!(
            &requests[0],
            (
                HerdrControlRequest::PaneSendInput { text, keys, .. },
                true
            ) if text == "review" && keys.is_empty()
        ));
        assert!(matches!(
            &requests[1],
            (HerdrControlRequest::PaneSendText { text, .. }, false) if text == " "
        ));
        assert!(matches!(
            &requests[2],
            (
                HerdrControlRequest::PaneSendInput { text, keys, .. },
                true
            ) if text == "/tmp/image.png" && keys == &["enter"]
        ));

        assert!(matches!(
            pane_submission_requests("pane-1".to_owned(), Vec::new()).as_slice(),
            [(HerdrControlRequest::PaneSendKeys { keys, .. }, false)] if keys == &["enter"]
        ));
    }

    fn batch_test_snapshot() -> HerdrSessionSnapshot {
        let pane = |id: &str| HerdrPaneInfo {
            pane_id: id.to_owned(),
            terminal_id: format!("terminal-{id}"),
            workspace_id: "workspace".to_owned(),
            tab_id: "tab".to_owned(),
            focused: id == "pane-1",
            cwd: None,
            foreground_cwd: None,
            label: None,
            agent: None,
            title: None,
            terminal_title: None,
            terminal_title_stripped: None,
            display_agent: None,
            agent_status: HerdrAgentStatus::Idle,
            state_labels: None,
            tokens: None,
            agent_session: None,
            scroll: None,
            revision: 0.0,
        };
        HerdrSessionSnapshot {
            version: "test".to_owned(),
            protocol: 22,
            focused_workspace_id: Some("workspace".to_owned()),
            focused_tab_id: Some("tab".to_owned()),
            focused_pane_id: Some("pane-1".to_owned()),
            agents: Vec::new(),
            workspaces: vec![HerdrWorkspaceInfo {
                workspace_id: "workspace".to_owned(),
                number: 1.0,
                label: "workspace".to_owned(),
                focused: true,
                pane_count: 2.0,
                tab_count: 1.0,
                active_tab_id: "tab".to_owned(),
                agent_status: HerdrAgentStatus::Idle,
                tokens: None,
                worktree: None,
            }],
            tabs: vec![HerdrTabInfo {
                tab_id: "tab".to_owned(),
                workspace_id: "workspace".to_owned(),
                number: 1.0,
                label: "tab".to_owned(),
                focused: true,
                pane_count: 2.0,
                agent_status: HerdrAgentStatus::Idle,
            }],
            panes: vec![pane("pane-1"), pane("pane-2")],
            layouts: Vec::new(),
        }
    }

    fn agent_status_event(pane_id: &str, status: HerdrAgentStatus) -> HerdrEvent {
        HerdrEvent::PaneAgentStatusChanged {
            workspace_id: "workspace".to_owned(),
            pane_id: pane_id.to_owned(),
            agent_status: status,
            agent: Some("codex".to_owned()),
            title: None,
            display_agent: None,
            state_labels: None,
        }
    }

    #[test]
    fn ssh_failures_map_to_typed_runtime_errors() {
        let authentication =
            HostRuntimeError::from(SshFailure::Authentication("bad credentials".to_owned()));
        assert!(matches!(
            authentication,
            HostRuntimeError::AuthenticationFailure(message) if message == "bad credentials"
        ));

        let host_key = HostRuntimeError::from(SshFailure::HostKeyChanged(Box::new(
            crate::ssh::HostKeyChallenge {
                host: "example.com".to_owned(),
                port: 2222,
                key_type: "ssh-ed25519".to_owned(),
                fingerprint: "SHA256:new".to_owned(),
                public_key: "ssh-ed25519 AAAA".to_owned(),
            },
        )));
        assert!(matches!(
            host_key,
            HostRuntimeError::HostKeyChanged(challenge)
                if challenge.host == "example.com" && challenge.port == 2222
        ));

        assert_eq!(
            HostRuntimeError::from(SshFailure::UnsupportedHostCertificate),
            HostRuntimeError::UnsupportedHostCertificate,
        );

        let transport = HostRuntimeError::from(SshFailure::Transport {
            code: SshErrorCode::ConnectionTimeout,
            message: "timed out".to_owned(),
        });
        assert!(matches!(
            transport,
            HostRuntimeError::SshConnectionFailure {
                code: SshErrorCode::ConnectionTimeout,
                message,
            } if message == "timed out"
        ));
    }

    #[test]
    fn runtime_callbacks_are_reentrant_and_diagnostics_are_isolated() {
        let _guard = EVENT_SINK_TEST_LOCK.lock();
        let runtime_config = config();
        let inner = runtime_inner_with_state(
            "reentrant-test",
            runtime_config.clone(),
            RuntimeState::new(&runtime_config),
        );
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

        let diagnostics = Arc::new(RecordingRuntimeSink::default());
        set_host_runtime_event_sink(diagnostics.clone());
        emit_diagnostic(
            &inner,
            RuntimeDiagnosticOperation::TerminalAttach,
            Instant::now(),
            None,
            Some("terminal-1".to_owned()),
            None,
        );
        emit_diagnostic(
            &inner,
            RuntimeDiagnosticOperation::TerminalRecovery,
            Instant::now(),
            None,
            Some("terminal-1".to_owned()),
            Some("closed".to_owned()),
        );
        clear_host_runtime_event_sink();
        let events = diagnostics.events.lock();
        assert!(matches!(
            &events[0],
            HostRuntimeEvent::Diagnostic { diagnostic, .. }
                if diagnostic.outcome == RuntimeDiagnosticOutcome::Succeeded
        ));
        assert!(matches!(
            &events[1],
            HostRuntimeEvent::Diagnostic { diagnostic, .. }
                if diagnostic.outcome == RuntimeDiagnosticOutcome::Failed
                    && diagnostic.error.as_deref() == Some("closed")
        ));
        drop(events);

        set_host_runtime_event_sink(Arc::new(PanickingRuntimeSink));
        emit_diagnostic(
            &inner,
            RuntimeDiagnosticOperation::SshConnect,
            Instant::now(),
            None,
            None,
            None,
        );
        clear_host_runtime_event_sink();
    }

    #[test]
    fn herdr_event_burst_is_fully_applied_before_one_projection() {
        let _guard = EVENT_SINK_TEST_LOCK.lock();
        let runtime_config = config();
        let mut state = RuntimeState::new(&runtime_config);
        state.connection = HostConnectionState::Connected;
        state.generation = 1;
        state.event = Some(EventSubscriptionRuntime {
            pane_ids: vec!["pane-1".to_owned(), "pane-2".to_owned()],
            operation_epoch: 1,
            retry_running: false,
        });
        state.host_state.connection_installed(1);
        let token = state.host_state.begin_sync(1);
        state
            .host_state
            .complete_sync(token, batch_test_snapshot(), 1);
        let inner = runtime_inner_with_state("batch-delivery-test", runtime_config, state);
        runtimes()
            .write()
            .insert(inner.id.clone(), Arc::downgrade(&inner));
        let sink = Arc::new(RecordingRuntimeSink::default());
        set_host_runtime_event_sink(sink.clone());

        let revision_before_output = inner.state.lock().host_state.projection().revision;
        let output_forwarded = deliver_herdr_events(
            &inner.id,
            vec![HerdrEvent::PaneOutputChanged {
                workspace_id: "workspace-1".to_owned(),
                pane_id: "pane-1".to_owned(),
                revision: 2.0,
            }],
        );
        assert!(output_forwarded.is_none());
        assert!(sink.events.lock().is_empty());
        assert_eq!(
            inner.state.lock().host_state.projection().revision,
            revision_before_output
        );

        let forwarded = deliver_herdr_events(
            &inner.id,
            vec![
                agent_status_event("pane-1", HerdrAgentStatus::Blocked),
                agent_status_event("pane-2", HerdrAgentStatus::Working),
                agent_status_event("pane-1", HerdrAgentStatus::Idle),
            ],
        );
        clear_host_runtime_event_sink();
        runtimes().write().remove(&inner.id);

        assert!(forwarded.is_none());
        let events = sink.events.lock();
        assert_eq!(events.len(), 1);
        let HostRuntimeEvent::HostStateChanged {
            state,
            changed_agent_pane_ids,
            ..
        } = &events[0]
        else {
            panic!("event burst emitted an unexpected runtime event");
        };
        assert_eq!(changed_agent_pane_ids, &["pane-1", "pane-2"]);
        let snapshot = state.snapshot.as_ref().unwrap();
        assert_eq!(snapshot.panes[0].agent_status, HerdrAgentStatus::Idle);
        assert_eq!(snapshot.panes[1].agent_status, HerdrAgentStatus::Working);
        drop(events);
    }

    #[test]
    fn herdr_event_batch_preserves_resync_requests() {
        let mut state = RuntimeState::new(&config());
        state.connection = HostConnectionState::Connected;
        state.generation = 1;
        state.host_state.connection_installed(1);
        let token = state.host_state.begin_sync(1);
        state
            .host_state
            .complete_sync(token, batch_test_snapshot(), 1);

        let result = apply_herdr_event_batch(
            &mut state,
            [agent_status_event(
                "missing-pane",
                HerdrAgentStatus::Working,
            )],
        );
        assert!(result.changed);
        assert!(result.resync_reason.is_some());
        assert!(state.host_state.projection().needs_resync);
    }

    #[test]
    fn confirmed_pane_close_cancels_terminal_retry_without_restarting_events() {
        let _guard = EVENT_SINK_TEST_LOCK.lock();
        let inner = connected_runtime_inner("pane-close-local-test");
        {
            let mut state = inner.state.lock();
            let token = state.host_state.begin_sync(1);
            assert_eq!(
                state
                    .host_state
                    .complete_sync(token, batch_test_snapshot(), 1),
                ApplyResult::Applied
            );
            state.event = Some(EventSubscriptionRuntime {
                pane_ids: vec!["pane-1".to_owned(), "pane-2".to_owned()],
                operation_epoch: 1,
                retry_running: false,
            });
            for terminal_id in ["terminal-pane-1", "terminal-pane-2"] {
                state.terminals.insert(
                    terminal_id.to_owned(),
                    TerminalRuntime {
                        state: HostTerminalState::Attached,
                        takeover: true,
                        columns: 80,
                        rows: 24,
                        cell_width_px: 0,
                        cell_height_px: 0,
                        operation_epoch: 1,
                        reconnect_attempt: 0,
                        retry_running: false,
                        bridge_id: Some(1),
                    },
                );
            }
        }
        let sink = Arc::new(RecordingRuntimeSink::default());
        set_host_runtime_event_sink(sink.clone());

        reconcile_control_result(
            &inner,
            &HerdrControlRequest::PaneClose {
                pane_id: "pane-1".to_owned(),
            },
            &HerdrControlResult::Ok,
            Some("terminal-pane-1"),
        );

        clear_host_runtime_event_sink();
        let state = inner.state.lock();
        assert!(!state.terminals.contains_key("terminal-pane-1"));
        assert!(state.terminals.contains_key("terminal-pane-2"));
        assert_eq!(state.event.as_ref().unwrap().pane_ids, ["pane-1", "pane-2"]);
        assert!(!state.host_state.projection().needs_resync);
        assert!(!state.host_state.resync_running());
        assert!(
            state
                .host_state
                .projection()
                .snapshot
                .unwrap()
                .panes
                .iter()
                .all(|pane| pane.pane_id != "pane-1")
        );
        drop(state);

        let events = sink.events.lock();
        assert!(events.iter().any(|event| matches!(
            event,
            HostRuntimeEvent::TerminalStateChanged {
                terminal_id,
                state: HostTerminalState::Closed,
                retrying: false,
                ..
            } if terminal_id == "terminal-pane-1"
        )));
        drop(events);
    }

    #[test]
    fn event_subscription_closure_schedules_snapshot_resync() {
        let _guard = EVENT_SINK_TEST_LOCK.lock();
        let inner = connected_runtime_inner("event-subscription-resync-test");
        runtimes()
            .write()
            .insert(inner.id.clone(), Arc::downgrade(&inner));

        assert!(event_subscription_closed(
            &inner.id,
            "unexpected EOF".to_owned(),
        ));

        {
            let mut state = inner.state.lock();
            assert!(state.host_state.projection().needs_resync);
            assert!(state.host_state.resync_running());
            assert!(state.event.as_ref().unwrap().retry_running);
            state.explicit_disconnect = true;
        }
        runtimes().write().remove(&inner.id);
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
    fn reconnect_waiter_cannot_miss_fast_connected_transition() {
        let _guard = EVENT_SINK_TEST_LOCK.lock();
        crate::runtime().unwrap().block_on(async {
            let inner = connected_runtime_inner("fast-reconnect-wait-test");
            let epoch = inner
                .state
                .lock()
                .begin_reconnect(None, "transport closed")
                .expect("connected runtime starts reconnect")
                .0;
            publish_lifecycle_status(&inner);
            let status_rx = inner.status_tx.subscribe();

            assert!(inner.state.lock().install_connection(epoch));
            publish_lifecycle_status(&inner);

            assert_eq!(wait_for_reconnect(status_rx).await, Ok(()));
        });
    }

    #[test]
    fn reconnect_receiver_created_while_connected_returns_immediately() {
        crate::runtime().unwrap().block_on(async {
            let inner = connected_runtime_inner("already-connected-wait-test");
            assert_eq!(
                wait_for_reconnect(inner.status_tx.subscribe()).await,
                Ok(())
            );
        });
    }

    #[test]
    fn reconnect_exhaustion_preserves_latest_error() {
        let _guard = EVENT_SINK_TEST_LOCK.lock();
        crate::runtime().unwrap().block_on(async {
            let inner = connected_runtime_inner("reconnect-exhaustion-wait-test");
            inner
                .state
                .lock()
                .begin_reconnect(None, "transport closed")
                .expect("connected runtime starts reconnect");
            publish_lifecycle_status(&inner);
            let status_rx = inner.status_tx.subscribe();
            {
                let mut state = inner.state.lock();
                state.connection = HostConnectionState::Failed;
                state.reconnect_running = false;
                state.last_error = Some("authentication was rejected".to_owned());
            }
            publish_lifecycle_status(&inner);

            assert_eq!(
                wait_for_reconnect(status_rx).await,
                Err(HostRuntimeError::ReconnectExhausted(
                    "authentication was rejected".to_owned()
                ))
            );
        });
    }

    #[test]
    fn explicit_disconnect_wakes_reconnect_waiter() {
        let _guard = EVENT_SINK_TEST_LOCK.lock();
        crate::runtime().unwrap().block_on(async {
            let inner = connected_runtime_inner("disconnect-reconnect-wait-test");
            inner
                .state
                .lock()
                .begin_reconnect(None, "transport closed")
                .expect("connected runtime starts reconnect");
            publish_lifecycle_status(&inner);
            let status_rx = inner.status_tx.subscribe();
            let waiter = tokio::spawn(wait_for_reconnect(status_rx));

            inner.state.lock().disconnect();
            publish_lifecycle_status(&inner);

            assert!(matches!(
                waiter.await,
                Ok(Err(HostRuntimeError::RuntimeDisconnected(_)))
            ));
        });
    }

    #[test]
    fn simultaneous_recovery_waiters_observe_one_reconnect_lifecycle() {
        let _guard = EVENT_SINK_TEST_LOCK.lock();
        crate::runtime().unwrap().block_on(async {
            let inner = connected_runtime_inner("simultaneous-recovery-wait-test");
            let epoch = inner
                .state
                .lock()
                .begin_reconnect(None, "transport closed")
                .expect("connected runtime starts reconnect")
                .0;
            publish_lifecycle_status(&inner);
            let waiter_one = tokio::spawn(wait_for_reconnect(inner.status_tx.subscribe()));
            let waiter_two = tokio::spawn(wait_for_reconnect(inner.status_tx.subscribe()));
            let waiter_three = tokio::spawn(wait_for_reconnect(inner.status_tx.subscribe()));

            assert!(inner.state.lock().install_connection(epoch));
            publish_lifecycle_status(&inner);

            let (one, two, three) = tokio::join!(waiter_one, waiter_two, waiter_three);
            assert!(matches!(one, Ok(Ok(()))));
            assert!(matches!(two, Ok(Ok(()))));
            assert!(matches!(three, Ok(Ok(()))));
        });
    }

    #[test]
    fn closed_lifecycle_sender_fails_reconnect_waiter() {
        crate::runtime().unwrap().block_on(async {
            let (status_tx, status_rx) = watch::channel(HostRuntimeStatus {
                state: HostConnectionState::Reconnecting,
                generation: 1,
                reconnect_attempt: 1,
                error: Some("transport closed".to_owned()),
            });
            drop(status_tx);

            assert!(matches!(
                wait_for_reconnect(status_rx).await,
                Err(HostRuntimeError::RuntimeDisconnected(_))
            ));
        });
    }

    #[test]
    fn terminal_notify_still_wakes_existing_open_waiter() {
        crate::runtime().unwrap().block_on(async {
            let inner = connected_runtime_inner("terminal-open-wait-test");
            inner.state.lock().terminals.insert(
                "terminal-1".to_owned(),
                TerminalRuntime {
                    state: HostTerminalState::Opening,
                    takeover: true,
                    columns: 80,
                    rows: 24,
                    cell_width_px: 8,
                    cell_height_px: 16,
                    operation_epoch: 1,
                    reconnect_attempt: 0,
                    retry_running: true,
                    bridge_id: None,
                },
            );
            let waiter_inner = inner.clone();
            let waiter = tokio::spawn(async move {
                wait_for_terminal_open(&waiter_inner, "terminal-1", 1).await
            });
            tokio::task::yield_now().await;

            {
                let mut state = inner.state.lock();
                let terminal = state
                    .terminals
                    .get_mut("terminal-1")
                    .expect("terminal remains registered");
                terminal.state = HostTerminalState::Attached;
                terminal.retry_running = false;
                terminal.bridge_id = Some(1);
                drop(state);
            }
            inner.terminal_settled.notify_waiters();

            assert!(matches!(waiter.await, Ok(Ok(()))));
        });
    }

    #[test]
    fn bridge_close_during_open_invalidates_owned_attempt_without_second_worker() {
        let _guard = EVENT_SINK_TEST_LOCK.lock();
        clear_host_runtime_event_sink();
        let inner = connected_runtime_inner("terminal-close-during-open-test");
        inner.state.lock().terminals.insert(
            "terminal-1".to_owned(),
            TerminalRuntime {
                state: HostTerminalState::Opening,
                takeover: true,
                columns: 80,
                rows: 24,
                cell_width_px: 8,
                cell_height_px: 16,
                operation_epoch: 7,
                reconnect_attempt: 2,
                retry_running: true,
                bridge_id: Some(41),
            },
        );

        schedule_terminal_retry(
            inner.clone(),
            "terminal-1".to_owned(),
            Some(41),
            "bridge closed before attach committed".to_owned(),
        );

        let state = inner.state.lock();
        let terminal = &state.terminals["terminal-1"];
        assert_eq!(terminal.state, HostTerminalState::Failed);
        assert_eq!(terminal.bridge_id, None);
        assert!(terminal.retry_running);
        assert_eq!(terminal.operation_epoch, 7);
        assert_eq!(terminal.reconnect_attempt, 2);
        drop(state);
    }

    #[test]
    fn stale_bridge_close_cannot_invalidate_replacement() {
        let _guard = EVENT_SINK_TEST_LOCK.lock();
        clear_host_runtime_event_sink();
        let inner = connected_runtime_inner("stale-terminal-close-test");
        inner.state.lock().terminals.insert(
            "terminal-1".to_owned(),
            TerminalRuntime {
                state: HostTerminalState::Attached,
                takeover: true,
                columns: 80,
                rows: 24,
                cell_width_px: 8,
                cell_height_px: 16,
                operation_epoch: 8,
                reconnect_attempt: 0,
                retry_running: false,
                bridge_id: Some(42),
            },
        );

        schedule_terminal_retry(
            inner.clone(),
            "terminal-1".to_owned(),
            Some(41),
            "old bridge closed late".to_owned(),
        );

        let state = inner.state.lock();
        let terminal = &state.terminals["terminal-1"];
        assert_eq!(terminal.state, HostTerminalState::Attached);
        assert_eq!(terminal.bridge_id, Some(42));
        assert!(!terminal.retry_running);
        drop(state);
    }

    #[test]
    fn bridge_claim_is_scoped_to_the_current_open_operation() {
        let inner = connected_runtime_inner("terminal-bridge-claim-test");
        inner.state.lock().terminals.insert(
            "terminal-1".to_owned(),
            TerminalRuntime {
                state: HostTerminalState::Restoring,
                takeover: true,
                columns: 80,
                rows: 24,
                cell_width_px: 8,
                cell_height_px: 16,
                operation_epoch: 9,
                reconnect_attempt: 1,
                retry_running: true,
                bridge_id: None,
            },
        );

        assert_eq!(claim_terminal_bridge(&inner, "terminal-1", 9, 51), Ok(()));
        assert_eq!(
            inner.state.lock().terminals["terminal-1"].bridge_id,
            Some(51)
        );
        assert!(matches!(
            claim_terminal_bridge(&inner, "terminal-1", 8, 50),
            Err(HerdrBridgeError::BridgeUnavailable(_))
        ));
        assert_eq!(
            inner.state.lock().terminals["terminal-1"].bridge_id,
            Some(51)
        );
    }

    #[test]
    fn unexpected_transport_death_starts_host_reconnect() {
        let mut state = RuntimeState::new(&config());
        let epoch = state.begin_connect().unwrap();
        assert!(state.install_connection(epoch));

        assert!(
            state
                .begin_reconnect(Some(1), "SSH transport disconnected")
                .is_some()
        );
        assert_eq!(state.connection, HostConnectionState::Reconnecting);
        assert!(state.reconnect_running);
    }

    #[test]
    fn explicit_disconnect_rejects_transport_reconnect() {
        let mut state = RuntimeState::new(&config());
        let epoch = state.begin_connect().unwrap();
        assert!(state.install_connection(epoch));
        state.disconnect();

        assert!(
            state
                .begin_reconnect(Some(1), "russh callback after user disconnect")
                .is_none()
        );
    }

    #[test]
    fn simultaneous_transport_failures_start_one_reconnect() {
        let mut state = RuntimeState::new(&config());
        let epoch = state.begin_connect().unwrap();
        assert!(state.install_connection(epoch));

        assert!(state.begin_reconnect(Some(1), "channel failed").is_some());
        assert!(
            state
                .begin_reconnect(Some(1), "russh disconnected")
                .is_none()
        );
        assert_eq!(state.epoch, epoch.wrapping_add(1));
    }

    #[test]
    fn stale_session_generation_cannot_reconnect_replacement() {
        let mut state = RuntimeState::new(&config());
        let first = state.begin_connect().unwrap();
        assert!(state.install_connection(first));
        state.connection = HostConnectionState::Failed;
        let second = state.begin_connect().unwrap();
        assert!(state.install_connection(second));
        assert_eq!(state.generation, 2);

        assert!(
            state
                .begin_reconnect(Some(1), "old session disconnected")
                .is_none()
        );
        assert_eq!(state.connection, HostConnectionState::Connected);
        assert!(!state.reconnect_running);
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
                reconnect_attempt: 3,
                retry_running: true,
                bridge_id: None,
            },
        );
        state.disconnect();
        assert!(state.event.is_none());
        let terminal = &state.terminals["t1"];
        assert_eq!(terminal.state, HostTerminalState::Closed);
        assert!(!terminal.retry_running);
        assert_eq!(terminal.reconnect_attempt, 0);
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
            reconnect_attempt: 2,
            retry_running: false,
            bridge_id: None,
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
        assert_eq!(terminal.reconnect_attempt, 2);
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
            reconnect_attempt: 1,
            retry_running: true,
            bridge_id: None,
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
                reconnect_attempt: 5,
                retry_running: false,
                bridge_id: None,
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
            reconnect_attempt: 1,
            retry_running: false,
            bridge_id: None,
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
        assert!(safe_control_replay(&HerdrControlRequest::SessionSnapshot));
        assert!(safe_control_replay(&HerdrControlRequest::PaneRead {
            pane_id: "p".to_owned(),
            lines: 10
        }));
        assert!(!safe_control_replay(&HerdrControlRequest::PaneSendText {
            pane_id: "p".to_owned(),
            text: "hello".to_owned()
        }));
        assert_eq!(
            request_replay(&HerdrControlRequest::SessionSnapshot),
            HerdrRequestReplay::AfterSocketRediscovery
        );
        assert_eq!(
            request_replay(&HerdrControlRequest::PaneSendText {
                pane_id: "p".to_owned(),
                text: "do not replay".to_owned(),
            },),
            HerdrRequestReplay::Never
        );
    }
}
