//! Rust-owned lifecycle for remote coding-agent transcript sessions.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use chrono::NaiveDateTime;
use parking_lot::{Mutex, RwLock};

use crate::agent_transcript::{
    AgentCacheError, AgentTranscriptKind, AgentTranscriptState, CodexSessionCore,
    OpenCodeSessionCore, parse_open_code_cursor,
};
use crate::ssh::SshSession;

const RETRY_DELAY: Duration = Duration::from_millis(1_500);
const OPENCODE_POLL_DELAY: Duration = Duration::from_millis(1_200);
static NEXT_STREAM_CONTEXT: AtomicU64 = AtomicU64::new(1);
static STREAMS: OnceLock<RwLock<HashMap<u64, StreamContext>>> = OnceLock::new();
static EVENT_SINK: OnceLock<RwLock<Option<Arc<dyn AgentTranscriptEventSink>>>> = OnceLock::new();

fn streams() -> &'static RwLock<HashMap<u64, StreamContext>> {
    STREAMS.get_or_init(|| RwLock::new(HashMap::new()))
}

fn event_sink() -> &'static RwLock<Option<Arc<dyn AgentTranscriptEventSink>>> {
    EVENT_SINK.get_or_init(|| RwLock::new(None))
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct AgentTranscriptCacheWrite {
    pub key: String,
    pub blob: Vec<u8>,
    pub confirmation_token: String,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct AgentTranscriptEvent {
    pub runtime_id: String,
    pub key: String,
    pub state: AgentTranscriptState,
    pub cache_write: Option<AgentTranscriptCacheWrite>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct AgentSessionOpenResult {
    pub key: String,
    pub state: AgentTranscriptState,
}

#[uniffi::export(with_foreign)]
pub trait AgentTranscriptEventSink: Send + Sync {
    fn event(&self, event: AgentTranscriptEvent);
}

#[uniffi::export]
pub fn set_agent_transcript_event_sink(sink: Arc<dyn AgentTranscriptEventSink>) {
    *event_sink().write() = Some(sink);
}

#[uniffi::export]
pub fn clear_agent_transcript_event_sink() {
    *event_sink().write() = None;
}

#[derive(Clone, Debug, thiserror::Error, uniffi::Error, PartialEq, Eq)]
pub enum AgentSessionError {
    #[error("unsupported agent session: {0}")]
    UnsupportedAgent(String),
    #[error("invalid agent session: {0}")]
    InvalidSession(String),
    #[error("agent transcript source is unavailable: {0}")]
    SourceUnavailable(String),
    #[error("agent transcript read failed: {0}")]
    ReadFailed(String),
    #[error("agent transcript cache is corrupt: {0}")]
    CorruptedCache(String),
    #[error("agent transcript session is closed: {0}")]
    SessionClosed(String),
    #[error("agent transcript operation is stale: {0}")]
    StaleGeneration(String),
    #[error("host transport is disconnected: {0}")]
    TransportDisconnected(String),
}

impl From<AgentCacheError> for AgentSessionError {
    fn from(error: AgentCacheError) -> Self {
        Self::CorruptedCache(error.to_string())
    }
}

#[derive(Debug)]
struct SessionRuntime {
    key: String,
    session_id: String,
    terminals: HashSet<String>,
    core: AgentSessionCore,
    host_generation: u64,
    operation_epoch: u64,
    stream_context: Option<u64>,
    stream_channel_id: Option<String>,
    retry_running: bool,
    pending_cache_offset: Option<u64>,
    closed: bool,
}

#[derive(Debug)]
enum AgentSessionCore {
    Codex(Box<CodexSessionCore>),
    OpenCode(Box<OpenCodeSessionCore>),
}

impl AgentSessionCore {
    fn kind(&self) -> AgentTranscriptKind {
        match self {
            Self::Codex(_) => AgentTranscriptKind::Codex,
            Self::OpenCode(_) => AgentTranscriptKind::OpenCode,
        }
    }

    fn state(&self) -> AgentTranscriptState {
        match self {
            Self::Codex(core) => core.state(),
            Self::OpenCode(core) => core.state(),
        }
    }

    fn mark_stale(&mut self, reason: impl Into<String>) -> AgentTranscriptState {
        let reason = reason.into();
        match self {
            Self::Codex(core) => core.mark_stale(reason),
            Self::OpenCode(core) => core.mark_stale(reason),
        }
    }

    fn mark_unavailable(&mut self, reason: impl Into<String>) -> AgentTranscriptState {
        let reason = reason.into();
        match self {
            Self::Codex(core) => core.mark_unavailable(reason),
            Self::OpenCode(core) => core.mark_unavailable(reason),
        }
    }

    fn close(&mut self) -> AgentTranscriptState {
        match self {
            Self::Codex(core) => core.close(),
            Self::OpenCode(core) => core.close(),
        }
    }

    fn restore_cache(&mut self, bytes: &[u8]) -> Result<AgentTranscriptState, AgentCacheError> {
        match self {
            Self::Codex(core) => core.restore_cache(bytes),
            Self::OpenCode(core) => core.restore_cache(bytes),
        }
    }

    fn confirm_cache(&mut self, source_generation: u64, position: u64) -> bool {
        match self {
            Self::Codex(core) => core.confirm_cache(source_generation, position),
            Self::OpenCode(core) => core.confirm_cache(source_generation, position),
        }
    }
}

#[derive(Clone, Debug)]
struct PendingCheckpoint {
    session_key: String,
    source_generation: u64,
    offset: u64,
}

#[derive(Debug)]
struct ManagerState {
    connected_generation: Option<u64>,
    sessions: HashMap<String, SessionRuntime>,
    terminal_bindings: HashMap<String, String>,
    checkpoints: HashMap<String, PendingCheckpoint>,
    next_checkpoint: u64,
    closed: bool,
}

struct AgentSessionManagerInner {
    runtime_id: String,
    ssh: Arc<RwLock<Option<Arc<SshSession>>>>,
    state: Mutex<ManagerState>,
}

#[derive(Clone)]
pub(crate) struct AgentSessionManager {
    inner: Arc<AgentSessionManagerInner>,
}

#[derive(Clone)]
struct StreamContext {
    manager: Weak<AgentSessionManagerInner>,
    session_key: String,
    host_generation: u64,
    source_generation: u64,
    operation_epoch: u64,
}

impl AgentSessionManager {
    pub(crate) fn new(runtime_id: String, ssh: Arc<RwLock<Option<Arc<SshSession>>>>) -> Self {
        Self {
            inner: Arc::new(AgentSessionManagerInner {
                runtime_id,
                ssh,
                state: Mutex::new(ManagerState {
                    connected_generation: None,
                    sessions: HashMap::new(),
                    terminal_bindings: HashMap::new(),
                    checkpoints: HashMap::new(),
                    next_checkpoint: 1,
                    closed: false,
                }),
            }),
        }
    }

    pub(crate) fn connected(&self, generation: u64) {
        let keys = {
            let mut state = self.inner.state.lock();
            state.connected_generation = Some(generation);
            state.closed = false;
            state.sessions.keys().cloned().collect::<Vec<_>>()
        };
        for key in keys {
            self.restart(key, "Host connection was replaced".to_owned());
        }
    }

    pub(crate) fn disconnected(&self, closed: bool, reason: &str) {
        let emissions = {
            let mut state = self.inner.state.lock();
            state.connected_generation = None;
            state.closed = closed;
            let ssh = self.inner.ssh.read().clone();
            let mut emissions = Vec::new();
            for session in state.sessions.values_mut() {
                session.operation_epoch = session.operation_epoch.saturating_add(1);
                session.retry_running = false;
                if let Some(context) = session.stream_context.take() {
                    streams().write().remove(&context);
                }
                if let Some(channel) = session.stream_channel_id.take()
                    && let Some(ssh) = &ssh
                {
                    let _ = ssh.close_exec(&channel);
                }
                let state = if closed {
                    session.closed = true;
                    session.core.close()
                } else {
                    session.core.mark_stale(reason)
                };
                emissions.push((session.key.clone(), state));
            }
            emissions
        };
        for (key, state) in emissions {
            emit(&self.inner, key, state, None);
        }
    }

    pub(crate) fn open_codex(
        &self,
        terminal_id: String,
        session_id: String,
        cache_blob: Option<Vec<u8>>,
    ) -> Result<(String, AgentTranscriptState), AgentSessionError> {
        validate_codex_session_id(&session_id)?;
        let key = format!("codex:{session_id}");
        let (state_snapshot, should_start) = {
            let mut state = self.inner.state.lock();
            if state.closed {
                return Err(AgentSessionError::SessionClosed(
                    "host runtime is closed".to_owned(),
                ));
            }
            if let Some(old_key) = state
                .terminal_bindings
                .insert(terminal_id.clone(), key.clone())
                && old_key != key
                && let Some(old) = state.sessions.get_mut(&old_key)
            {
                old.terminals.remove(&terminal_id);
            }
            let generation = state.connected_generation;
            let session = state.sessions.entry(key.clone()).or_insert_with(|| {
                let mut core =
                    AgentSessionCore::Codex(Box::new(CodexSessionCore::new(session_id.clone())));
                if let Some(blob) = cache_blob.as_deref() {
                    let _ = core.restore_cache(blob);
                }
                SessionRuntime {
                    key: key.clone(),
                    session_id: session_id.clone(),
                    terminals: HashSet::new(),
                    core,
                    host_generation: generation.unwrap_or(0),
                    operation_epoch: 0,
                    stream_context: None,
                    stream_channel_id: None,
                    retry_running: false,
                    pending_cache_offset: None,
                    closed: false,
                }
            });
            session.terminals.insert(terminal_id);
            session.closed = false;
            let should_start = generation.is_some() && session.stream_context.is_none();
            (session.core.state(), should_start)
        };
        if should_start {
            self.restart(key.clone(), "Opening Codex transcript".to_owned());
        }
        Ok((key, state_snapshot))
    }

    pub(crate) fn open_opencode(
        &self,
        terminal_id: String,
        session_id: String,
        cache_blob: Option<Vec<u8>>,
    ) -> Result<(String, AgentTranscriptState), AgentSessionError> {
        validate_opencode_session_id(&session_id)?;
        let key = format!("opencode:{session_id}");
        let (state_snapshot, should_start) = {
            let mut state = self.inner.state.lock();
            if state.closed {
                return Err(AgentSessionError::SessionClosed(
                    "host runtime is closed".to_owned(),
                ));
            }
            if let Some(old_key) = state
                .terminal_bindings
                .insert(terminal_id.clone(), key.clone())
                && old_key != key
                && let Some(old) = state.sessions.get_mut(&old_key)
            {
                old.terminals.remove(&terminal_id);
            }
            let generation = state.connected_generation;
            let session = state.sessions.entry(key.clone()).or_insert_with(|| {
                let mut core = AgentSessionCore::OpenCode(Box::new(OpenCodeSessionCore::new(
                    session_id.clone(),
                )));
                if let Some(blob) = cache_blob.as_deref() {
                    let _ = core.restore_cache(blob);
                }
                SessionRuntime {
                    key: key.clone(),
                    session_id: session_id.clone(),
                    terminals: HashSet::new(),
                    core,
                    host_generation: generation.unwrap_or(0),
                    operation_epoch: 0,
                    stream_context: None,
                    stream_channel_id: None,
                    retry_running: false,
                    pending_cache_offset: None,
                    closed: false,
                }
            });
            session.terminals.insert(terminal_id);
            session.closed = false;
            let should_start = generation.is_some() && session.operation_epoch == 0;
            (session.core.state(), should_start)
        };
        if should_start {
            self.restart(key.clone(), "Opening OpenCode transcript".to_owned());
        }
        Ok((key, state_snapshot))
    }

    pub(crate) fn state(&self, key: &str) -> Option<AgentTranscriptState> {
        self.inner
            .state
            .lock()
            .sessions
            .get(key)
            .map(|session| session.core.state())
    }

    pub(crate) fn close_terminal(&self, terminal_id: &str) {
        let close = {
            let mut state = self.inner.state.lock();
            let Some(key) = state.terminal_bindings.remove(terminal_id) else {
                return;
            };
            let Some(session) = state.sessions.get_mut(&key) else {
                return;
            };
            session.terminals.remove(terminal_id);
            session.terminals.is_empty().then_some(key)
        };
        if let Some(key) = close {
            self.close_session(&key);
        }
    }

    pub(crate) fn close_session(&self, key: &str) {
        let emission = {
            let mut state = self.inner.state.lock();
            let Some(mut session) = state.sessions.remove(key) else {
                return;
            };
            state.terminal_bindings.retain(|_, value| value != key);
            state
                .checkpoints
                .retain(|_, value| value.session_key != key);
            session.operation_epoch = session.operation_epoch.saturating_add(1);
            if let Some(context) = session.stream_context.take() {
                streams().write().remove(&context);
            }
            if let Some(channel) = session.stream_channel_id.take()
                && let Some(ssh) = self.inner.ssh.read().clone()
            {
                let _ = ssh.close_exec(&channel);
            }
            (session.key.clone(), session.core.close())
        };
        emit(&self.inner, emission.0, emission.1, None);
    }

    pub(crate) fn confirm_cache(&self, token: &str) -> bool {
        let mut state = self.inner.state.lock();
        let Some(checkpoint) = state.checkpoints.remove(token) else {
            return false;
        };
        let Some(session) = state.sessions.get_mut(&checkpoint.session_key) else {
            return false;
        };
        let confirmed = session
            .core
            .confirm_cache(checkpoint.source_generation, checkpoint.offset);
        if confirmed
            && session
                .pending_cache_offset
                .is_some_and(|offset| offset <= checkpoint.offset)
        {
            session.pending_cache_offset = None;
        }
        confirmed
    }

    fn restart(&self, key: String, reason: String) {
        let operation = {
            let mut state = self.inner.state.lock();
            let Some(host_generation) = state.connected_generation else {
                return;
            };
            let Some(session) = state.sessions.get_mut(&key) else {
                return;
            };
            if session.closed || session.terminals.is_empty() {
                return;
            }
            session.operation_epoch = session.operation_epoch.saturating_add(1);
            session.host_generation = host_generation;
            session.retry_running = false;
            session.pending_cache_offset = None;
            if let Some(context) = session.stream_context.take() {
                streams().write().remove(&context);
            }
            if let Some(channel) = session.stream_channel_id.take()
                && let Some(ssh) = self.inner.ssh.read().clone()
            {
                let _ = ssh.close_exec(&channel);
            }
            let kind = session.core.kind();
            if let AgentSessionCore::OpenCode(core) = &mut session.core {
                core.begin_sync_generation();
            }
            let snapshot = session.core.mark_stale(reason.clone());
            (
                host_generation,
                session.operation_epoch,
                session.session_id.clone(),
                snapshot,
                kind,
            )
        };
        emit(&self.inner, key.clone(), operation.3, None);
        let manager = self.clone();
        if let Ok(runtime) = crate::runtime() {
            runtime.spawn(async move {
                match operation.4 {
                    AgentTranscriptKind::Codex => {
                        manager
                            .resolve_and_open(key, operation.0, operation.1, operation.2)
                            .await;
                    }
                    AgentTranscriptKind::OpenCode => {
                        manager
                            .sync_opencode(key, operation.0, operation.1, operation.2)
                            .await;
                    }
                }
            });
        }
    }

    async fn resolve_and_open(
        &self,
        key: String,
        host_generation: u64,
        operation_epoch: u64,
        session_id: String,
    ) {
        let Some(ssh) = self.inner.ssh.read().clone() else {
            self.fail_and_retry(
                key,
                host_generation,
                operation_epoch,
                "host SSH session is disconnected".to_owned(),
                false,
            );
            return;
        };
        let result = async {
            let output = execute(&ssh, codex_rollout_find_command(&session_id)).await?;
            let path = resolve_rollout_path(&output, &session_id)?;
            let Some(path) = path else {
                return Err(AgentSessionError::SourceUnavailable(
                    "Codex has not created this rollout yet.".to_owned(),
                ));
            };
            let metadata = execute(
                &ssh,
                format!(
                    "stat -c '%d:%i %s' {} 2>/dev/null || stat -f '%d:%i %z' {}",
                    shell_quote(&path),
                    shell_quote(&path)
                ),
            )
            .await?;
            let (file_id, size) = parse_metadata(&metadata)?;
            Ok::<_, AgentSessionError>((path, file_id, size))
        }
        .await;
        let (path, file_id, size) = match result {
            Ok(result) => result,
            Err(error) => {
                let unavailable = matches!(error, AgentSessionError::SourceUnavailable(_));
                self.fail_and_retry(
                    key,
                    host_generation,
                    operation_epoch,
                    error.to_string(),
                    unavailable,
                );
                return;
            }
        };
        let opened = {
            let mut state = self.inner.state.lock();
            if state.connected_generation != Some(host_generation) {
                return;
            }
            let Some(session) = state.sessions.get_mut(&key) else {
                return;
            };
            if session.operation_epoch != operation_epoch || session.closed {
                return;
            }
            session.pending_cache_offset = None;
            let AgentSessionCore::Codex(core) = &mut session.core else {
                return;
            };
            let binding = core.bind_source(path.clone(), file_id.clone(), size);
            let context = NEXT_STREAM_CONTEXT.fetch_add(1, Ordering::Relaxed);
            let channel_id = format!("agent-transcript-{context}");
            streams().write().insert(
                context,
                StreamContext {
                    manager: Arc::downgrade(&self.inner),
                    session_key: key.clone(),
                    host_generation,
                    source_generation: binding.source_generation,
                    operation_epoch,
                },
            );
            session.stream_context = Some(context);
            session.stream_channel_id = Some(channel_id.clone());
            (context, channel_id, binding.start_offset)
        };
        let command = codex_stream_command(&path, opened.2);
        let context = opened.0;
        let data = Arc::new(move |bytes| stream_data(context, bytes));
        let closed = Arc::new(move |reason| stream_failed(context, reason));
        let stream_requested =
            if let Err(error) = ssh.open_exec(&opened.1, &command, data, closed).await {
                streams().write().remove(&opened.0);
                self.fail_and_retry(
                    key.clone(),
                    host_generation,
                    operation_epoch,
                    error.to_string(),
                    false,
                );
                false
            } else {
                true
            };
        if stream_requested && size == opened.2 {
            let emission = {
                let mut state = self.inner.state.lock();
                current_session_mut(&mut state, &key, host_generation, operation_epoch).and_then(
                    |session| match &mut session.core {
                        AgentSessionCore::Codex(core) => core.mark_live().then(|| core.state()),
                        AgentSessionCore::OpenCode(_) => None,
                    },
                )
            };
            if let Some(state) = emission {
                emit(&self.inner, key, state, None);
            }
        }
    }

    async fn sync_opencode(
        &self,
        key: String,
        host_generation: u64,
        operation_epoch: u64,
        session_id: String,
    ) {
        let Some(ssh) = self.inner.ssh.read().clone() else {
            self.fail_and_retry(
                key,
                host_generation,
                operation_epoch,
                "host SSH session is disconnected".to_owned(),
                false,
            );
            return;
        };
        let cursor_output = match execute(
            &ssh,
            opencode_login_command(&opencode_cursor_command(&session_id)),
        )
        .await
        {
            Ok(output) => output,
            Err(error) => {
                self.fail_and_retry(
                    key,
                    host_generation,
                    operation_epoch,
                    error.to_string(),
                    false,
                );
                return;
            }
        };
        let remote_cursor = match parse_open_code_cursor(&cursor_output) {
            Ok(cursor) => cursor,
            Err(error) => {
                self.fail_and_retry(
                    key,
                    host_generation,
                    operation_epoch,
                    error.to_string(),
                    false,
                );
                return;
            }
        };
        let local_cursor = {
            let mut state = self.inner.state.lock();
            let Some(session) =
                current_session_mut(&mut state, &key, host_generation, operation_epoch)
            else {
                return;
            };
            let AgentSessionCore::OpenCode(core) = &mut session.core else {
                return;
            };
            core.cursor()
        };

        if local_cursor == Some(remote_cursor) {
            let snapshot = {
                let mut state = self.inner.state.lock();
                current_session_mut(&mut state, &key, host_generation, operation_epoch).and_then(
                    |session| match &mut session.core {
                        AgentSessionCore::OpenCode(core) => {
                            Some(core.mark_live().then(|| core.state()))
                        }
                        AgentSessionCore::Codex(_) => None,
                    },
                )
            };
            if let Some(snapshot) = snapshot {
                if let Some(snapshot) = snapshot {
                    emit(&self.inner, key.clone(), snapshot, None);
                }
                self.schedule_opencode_poll(key, host_generation, operation_epoch, session_id);
            }
            return;
        }

        let needs_full = local_cursor.is_none_or(|cursor| remote_cursor < cursor);
        let command = if needs_full {
            opencode_export_command(&session_id)
        } else {
            opencode_events_command(&session_id, local_cursor.unwrap_or_default())
        };
        let payload = match execute(&ssh, opencode_login_command(&command)).await {
            Ok(output) => output,
            Err(error) => {
                self.fail_and_retry(
                    key,
                    host_generation,
                    operation_epoch,
                    error.to_string(),
                    false,
                );
                return;
            }
        };
        let applied = self.finish_opencode_sync(
            &key,
            host_generation,
            operation_epoch,
            remote_cursor,
            &payload,
            needs_full,
        );
        if let Err(error) = applied {
            if needs_full {
                self.fail_and_retry(key, host_generation, operation_epoch, error, false);
                return;
            }
            let export = execute(
                &ssh,
                opencode_login_command(&opencode_export_command(&session_id)),
            )
            .await;
            match export {
                Ok(export) => {
                    if let Err(export_error) = self.finish_opencode_sync(
                        &key,
                        host_generation,
                        operation_epoch,
                        remote_cursor,
                        &export,
                        true,
                    ) {
                        self.fail_and_retry(
                            key,
                            host_generation,
                            operation_epoch,
                            export_error,
                            false,
                        );
                        return;
                    }
                }
                Err(export_error) => {
                    self.fail_and_retry(
                        key,
                        host_generation,
                        operation_epoch,
                        format!("{error}; fallback export failed: {export_error}"),
                        false,
                    );
                    return;
                }
            }
        }
        self.schedule_opencode_poll(key, host_generation, operation_epoch, session_id);
    }

    fn finish_opencode_sync(
        &self,
        key: &str,
        host_generation: u64,
        operation_epoch: u64,
        remote_cursor: u64,
        payload: &str,
        full: bool,
    ) -> Result<(), String> {
        let emission = {
            let mut state = self.inner.state.lock();
            let (snapshot, cache_candidate) = {
                let session =
                    current_session_mut(&mut state, key, host_generation, operation_epoch)
                        .ok_or_else(|| "OpenCode transcript operation became stale".to_owned())?;
                let AgentSessionCore::OpenCode(core) = &mut session.core else {
                    return Err("OpenCode transcript was rebound to another agent".to_owned());
                };
                let transcript_changed = if full {
                    core.bootstrap(remote_cursor, payload)
                } else {
                    core.apply_events(remote_cursor, payload)
                }
                .map_err(|error| error.to_string())?;
                let status_changed = core.mark_live();
                let visible_changed = transcript_changed || status_changed;
                let cursor = core.cursor().unwrap_or(remote_cursor);
                let new_checkpoint = session
                    .pending_cache_offset
                    .is_none_or(|pending| cursor > pending);
                let cache = new_checkpoint
                    .then(|| core.cache_blob().ok())
                    .flatten()
                    .map(|blob| {
                        session.pending_cache_offset = Some(cursor);
                        (blob, core.source_generation(), cursor)
                    });
                let snapshot = (visible_changed || cache.is_some()).then(|| core.state());
                (snapshot, cache)
            };
            let cache = cache_candidate.map(|(blob, source_generation, cursor)| {
                let checkpoint = state.next_checkpoint;
                state.next_checkpoint = state.next_checkpoint.saturating_add(1);
                let token = format!("checkpoint-{checkpoint}");
                state.checkpoints.insert(
                    token.clone(),
                    PendingCheckpoint {
                        session_key: key.to_owned(),
                        source_generation,
                        offset: cursor,
                    },
                );
                AgentTranscriptCacheWrite {
                    key: key.to_owned(),
                    blob,
                    confirmation_token: token,
                }
            });
            snapshot.map(|snapshot| (snapshot, cache))
        };
        if let Some((snapshot, cache)) = emission {
            emit(&self.inner, key.to_owned(), snapshot, cache);
        }
        Ok(())
    }

    fn schedule_opencode_poll(
        &self,
        key: String,
        host_generation: u64,
        operation_epoch: u64,
        session_id: String,
    ) {
        let scheduled = {
            let mut state = self.inner.state.lock();
            let Some(session) =
                current_session_mut(&mut state, &key, host_generation, operation_epoch)
            else {
                return;
            };
            if session.retry_running || session.terminals.is_empty() {
                false
            } else {
                session.retry_running = true;
                true
            }
        };
        if !scheduled {
            return;
        }
        let manager = self.clone();
        if let Ok(runtime) = crate::runtime() {
            runtime.spawn(async move {
                tokio::time::sleep(OPENCODE_POLL_DELAY).await;
                let should_poll = {
                    let mut state = manager.inner.state.lock();
                    let Some(session) =
                        current_session_mut(&mut state, &key, host_generation, operation_epoch)
                    else {
                        return;
                    };
                    session.retry_running = false;
                    !session.terminals.is_empty() && !session.closed
                };
                if should_poll {
                    manager
                        .sync_opencode(key, host_generation, operation_epoch, session_id)
                        .await;
                }
            });
        }
    }

    fn fail_and_retry(
        &self,
        key: String,
        host_generation: u64,
        operation_epoch: u64,
        reason: String,
        unavailable: bool,
    ) {
        let emission = {
            let mut state = self.inner.state.lock();
            let session = current_session_mut(&mut state, &key, host_generation, operation_epoch);
            let Some(session) = session else {
                return;
            };
            if session.retry_running || session.terminals.is_empty() {
                return;
            }
            session.retry_running = true;
            if unavailable {
                session.core.mark_unavailable(reason.clone())
            } else {
                session.core.mark_stale(reason.clone())
            }
        };
        emit(&self.inner, key.clone(), emission, None);
        let manager = self.clone();
        if let Ok(runtime) = crate::runtime() {
            runtime.spawn(async move {
                tokio::time::sleep(RETRY_DELAY).await;
                let should_retry = {
                    let mut state = manager.inner.state.lock();
                    let Some(session) =
                        current_session_mut(&mut state, &key, host_generation, operation_epoch)
                    else {
                        return;
                    };
                    session.retry_running = false;
                    !session.terminals.is_empty() && !session.closed
                };
                if should_retry {
                    manager.restart(key, "Rebinding remote transcript".to_owned());
                }
            });
        }
    }
}

fn current_session_mut<'a>(
    state: &'a mut ManagerState,
    key: &str,
    host_generation: u64,
    operation_epoch: u64,
) -> Option<&'a mut SessionRuntime> {
    if state.connected_generation != Some(host_generation) {
        return None;
    }
    state.sessions.get_mut(key).filter(|session| {
        session.host_generation == host_generation
            && session.operation_epoch == operation_epoch
            && !session.closed
    })
}

fn emit(
    manager: &Arc<AgentSessionManagerInner>,
    key: String,
    state: AgentTranscriptState,
    cache_write: Option<AgentTranscriptCacheWrite>,
) {
    let sink = event_sink().read().clone();
    if let Some(sink) = sink {
        sink.event(AgentTranscriptEvent {
            runtime_id: manager.runtime_id.clone(),
            key,
            state,
            cache_write,
        });
    }
}

fn stream_data(context: u64, bytes: Vec<u8>) {
    let Some(context_value) = streams().read().get(&context).cloned() else {
        return;
    };
    let Some(manager) = context_value.manager.upgrade() else {
        streams().write().remove(&context);
        return;
    };
    let emission = {
        let mut state = manager.state.lock();
        let (snapshot, cache_candidate) = {
            let Some(session) = current_session_mut(
                &mut state,
                &context_value.session_key,
                context_value.host_generation,
                context_value.operation_epoch,
            ) else {
                return;
            };
            let AgentSessionCore::Codex(core) = &mut session.core else {
                return;
            };
            match core.ingest(context_value.source_generation, &bytes) {
                Ok(result) => {
                    let current_generation = result.source_generation == core.source_generation();
                    let status_changed = current_generation && core.mark_live();
                    let visible_changed = result.changed || status_changed;
                    let new_checkpoint = visible_changed
                        && result.committable_offset > core.committed_offset()
                        && session
                            .pending_cache_offset
                            .is_none_or(|offset| result.committable_offset > offset);
                    let cache = new_checkpoint
                        .then(|| core.cache_blob().ok())
                        .flatten()
                        .map(|blob| {
                            session.pending_cache_offset = Some(result.committable_offset);
                            (blob, result.committable_offset)
                        });
                    let snapshot = (visible_changed || cache.is_some()).then(|| core.state());
                    (snapshot, cache)
                }
                Err(error) => (Some(session.core.mark_stale(error.to_string())), None),
            }
        };
        let cache = cache_candidate.map(|(blob, offset)| {
            let checkpoint = state.next_checkpoint;
            state.next_checkpoint = state.next_checkpoint.saturating_add(1);
            let token = format!("checkpoint-{checkpoint}");
            state.checkpoints.insert(
                token.clone(),
                PendingCheckpoint {
                    session_key: context_value.session_key.clone(),
                    source_generation: context_value.source_generation,
                    offset,
                },
            );
            AgentTranscriptCacheWrite {
                key: context_value.session_key.clone(),
                blob,
                confirmation_token: token,
            }
        });
        snapshot.map(|snapshot| (snapshot, cache))
    };
    if let Some((state, cache)) = emission {
        emit(&manager, context_value.session_key, state, cache);
    }
}

fn stream_failed(context: u64, reason: String) {
    let Some(context_value) = streams().write().remove(&context) else {
        return;
    };
    let Some(manager) = context_value.manager.upgrade() else {
        return;
    };
    AgentSessionManager { inner: manager }.fail_and_retry(
        context_value.session_key,
        context_value.host_generation,
        context_value.operation_epoch,
        reason,
        false,
    );
}

async fn execute(ssh: &SshSession, command: String) -> Result<String, AgentSessionError> {
    let output = ssh
        .execute(&command)
        .await
        .map_err(|error| AgentSessionError::ReadFailed(error.message))?;
    if output.exit_status.is_some_and(|status| status != 0) {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr = stderr.trim();
        return Err(AgentSessionError::ReadFailed(if stderr.is_empty() {
            "remote transcript command failed".to_owned()
        } else {
            stderr.to_owned()
        }));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn validate_codex_session_id(value: &str) -> Result<(), AgentSessionError> {
    let valid = value.len() == 36
        && value
            .chars()
            .enumerate()
            .all(|(index, character)| match index {
                8 | 13 | 18 | 23 => character == '-',
                _ => character.is_ascii_hexdigit(),
            });
    if valid {
        Ok(())
    } else {
        Err(AgentSessionError::InvalidSession(
            "Codex session ID must be a UUID".to_owned(),
        ))
    }
}

fn validate_opencode_session_id(value: &str) -> Result<(), AgentSessionError> {
    let valid = value.strip_prefix("ses_").is_some_and(|suffix| {
        !suffix.is_empty() && suffix.chars().all(|value| value.is_ascii_alphanumeric())
    });
    if valid {
        Ok(())
    } else {
        Err(AgentSessionError::InvalidSession(
            "OpenCode session ID must match ses_[A-Za-z0-9]+".to_owned(),
        ))
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn opencode_login_command(command: &str) -> String {
    format!("exec \"${{SHELL:-/bin/sh}}\" -lc {}", shell_quote(command))
}

fn opencode_export_command(session_id: &str) -> String {
    format!("opencode export {}", shell_quote(session_id))
}

fn opencode_cursor_command(session_id: &str) -> String {
    let query = format!(
        "SELECT COALESCE(MAX(seq), 0) AS seq FROM event WHERE aggregate_id = '{session_id}'"
    );
    format!("opencode db {} --format json", shell_quote(&query))
}

fn opencode_events_command(session_id: &str, after_sequence: u64) -> String {
    let query = format!(
        "SELECT seq, type, data FROM event WHERE aggregate_id = '{session_id}' AND seq > {after_sequence} ORDER BY seq"
    );
    format!("opencode db {} --format json", shell_quote(&query))
}

fn codex_rollout_find_command(session_id: &str) -> String {
    let ordinary = shell_quote(&format!("rollout-*-{session_id}.jsonl"));
    let reverted = shell_quote(&format!("rollout-*-{session_id}_*.jsonl"));
    format!(
        "find \"$HOME/.codex/sessions\" -type f \\( -name {ordinary} -o -name {reverted} \\) -print"
    )
}

/// Stream raw rollout bytes immediately after the committed byte cursor.
///
/// Keep this as one direct exec rather than a remote shell supervisor. Besides
/// avoiding login-shell differences, this is the exact transport shape used
/// by the previous working TypeScript implementation. `-F` also survives a
/// same-path replacement; a new reverted-rollout filename is selected by the
/// Rust resolver whenever the stream is opened or rebound.
fn codex_stream_command(path: &str, offset: u64) -> String {
    let start = shell_quote(&format!("+{}", offset.saturating_add(1)));
    format!("exec tail -c {start} -F {}", shell_quote(path))
}

fn resolve_rollout_path(
    output: &str,
    session_id: &str,
) -> Result<Option<String>, AgentSessionError> {
    let paths = output
        .lines()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if paths.is_empty() {
        return Ok(None);
    }

    // Codex keeps the thread ID stable across thread/revert, but writes the
    // replacement as `<thread-id>_<rollout-id>`. Mirror Codex's filesystem
    // fallback: select the newest filename timestamp and use the rollout UUID
    // as a deterministic tie-breaker for files created in the same second.
    let expected_thread = parse_uuid_bytes(session_id).ok_or_else(|| {
        AgentSessionError::InvalidSession("Codex session ID must be a UUID".to_owned())
    })?;
    let mut newest: Option<(NaiveDateTime, [u8; 16], &str)> = None;
    for path in paths {
        let Some((timestamp, thread_id, rollout_id)) = parse_rollout_filename(path) else {
            continue;
        };
        if thread_id != expected_thread {
            continue;
        }
        let replace = newest
            .as_ref()
            .is_none_or(|(current_timestamp, current_rollout, _)| {
                timestamp > *current_timestamp
                    || (timestamp == *current_timestamp && rollout_id > *current_rollout)
            });
        if replace {
            newest = Some((timestamp, rollout_id, path));
        }
    }

    newest
        .map(|(_, _, path)| Some(path.to_owned()))
        .ok_or_else(|| {
            AgentSessionError::SourceUnavailable(
                "Codex returned no valid rollout path for the session ID".to_owned(),
            )
        })
}

fn parse_rollout_filename(path: &str) -> Option<(NaiveDateTime, [u8; 16], [u8; 16])> {
    let name = path.rsplit('/').next()?;
    let core = name.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
    let timestamp = core.get(..19)?;
    if core.get(19..20)? != "-" {
        return None;
    }
    let timestamp = NaiveDateTime::parse_from_str(timestamp, "%Y-%m-%dT%H-%M-%S").ok()?;
    let ids = core.get(20..)?;
    let (thread_id, rollout_id) = ids.split_once('_').unwrap_or((ids, ids));
    Some((
        timestamp,
        parse_uuid_bytes(thread_id)?,
        parse_uuid_bytes(rollout_id)?,
    ))
}

fn parse_uuid_bytes(value: &str) -> Option<[u8; 16]> {
    if value.len() != 36 {
        return None;
    }
    let mut bytes = [0_u8; 16];
    let mut nibble_index = 0_usize;
    for (index, character) in value.bytes().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            if character != b'-' {
                return None;
            }
            continue;
        }
        let nibble = match character {
            b'0'..=b'9' => character - b'0',
            b'a'..=b'f' => character - b'a' + 10,
            b'A'..=b'F' => character - b'A' + 10,
            _ => return None,
        };
        let byte = bytes.get_mut(nibble_index / 2)?;
        if nibble_index.is_multiple_of(2) {
            *byte = nibble << 4;
        } else {
            *byte |= nibble;
        }
        nibble_index += 1;
    }
    (nibble_index == 32).then_some(bytes)
}

fn parse_metadata(output: &str) -> Result<(String, u64), AgentSessionError> {
    let mut fields = output.split_whitespace();
    let file_id = fields.next().unwrap_or_default();
    let size = fields.next().and_then(|value| value.parse::<u64>().ok());
    let file_id_valid = file_id.split_once(':').is_some_and(|(device, inode)| {
        !device.is_empty()
            && !inode.is_empty()
            && device.chars().all(|value| value.is_ascii_digit())
            && inode.chars().all(|value| value.is_ascii_digit())
    });
    if !file_id_valid || size.is_none() || fields.next().is_some() {
        return Err(AgentSessionError::SourceUnavailable(
            "Codex returned invalid rollout metadata".to_owned(),
        ));
    }
    Ok((file_id.to_owned(), size.unwrap()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "11111111-1111-4111-8111-111111111111";

    #[test]
    fn validates_session_ids_before_building_remote_commands() {
        assert!(validate_codex_session_id(SESSION).is_ok());
        assert!(validate_codex_session_id(&format!("{SESSION}; uname -a")).is_err());
        assert!(validate_opencode_session_id("ses_abc123").is_ok());
        assert!(validate_opencode_session_id("ses_x'; DROP TABLE event;--").is_err());
    }

    #[test]
    fn opencode_commands_use_the_official_read_only_db_interface() {
        assert_eq!(
            opencode_export_command("ses_abc123"),
            "opencode export 'ses_abc123'"
        );
        assert!(opencode_cursor_command("ses_abc123").contains("MAX(seq)"));
        assert!(opencode_events_command("ses_abc123", 42).contains("seq > 42"));
        assert!(
            opencode_login_command("opencode export 'ses_abc123'")
                .starts_with("exec \"${SHELL:-/bin/sh}\" -lc ")
        );
    }

    #[test]
    fn rollout_resolution_accepts_an_ordinary_rollout() {
        let path = format!(
            "/home/me/.codex/sessions/2026/08/26/rollout-2026-08-26T10-20-30-{SESSION}.jsonl"
        );
        assert_eq!(
            resolve_rollout_path(&format!("{path}\n"), SESSION).unwrap(),
            Some(path)
        );
        assert!(resolve_rollout_path("/wrong.jsonl\n", SESSION).is_err());
        assert!(resolve_rollout_path("", SESSION).unwrap().is_none());
    }

    #[test]
    fn rollout_resolution_follows_the_newest_reverted_rollout() {
        let older = format!(
            "/home/me/.codex/sessions/2026/08/26/rollout-2026-08-26T10-20-30-{SESSION}.jsonl"
        );
        let rollout = "0198e6cc-9d62-7000-8000-000000000001";
        let newer = format!(
            "/home/me/.codex/sessions/2026/08/26/rollout-2026-08-26T10-21-30-{SESSION}_{rollout}.jsonl"
        );
        assert_eq!(
            resolve_rollout_path(&format!("{older}\n{newer}\n"), SESSION).unwrap(),
            Some(newer)
        );
    }

    #[test]
    fn rollout_resolution_uses_rollout_uuid_to_break_timestamp_ties() {
        let first_rollout = "0198e6cc-9d62-7000-8000-000000000001";
        let second_rollout = "0198e6cc-9d62-7000-8000-000000000002";
        let first =
            format!("/sessions/rollout-2026-08-26T10-20-30-{SESSION}_{first_rollout}.jsonl");
        let second =
            format!("/sessions/rollout-2026-08-26T10-20-30-{SESSION}_{second_rollout}.jsonl");
        assert_eq!(
            resolve_rollout_path(&format!("{second}\n{first}\n"), SESSION).unwrap(),
            Some(second)
        );
    }

    #[test]
    fn rollout_resolution_rejects_invalid_revert_suffixes_and_other_threads() {
        let other_thread = "22222222-2222-4222-8222-222222222222";
        let invalid = format!("/sessions/rollout-2026-08-26T10-20-30-{SESSION}_not-a-uuid.jsonl");
        let other = format!("/sessions/rollout-2026-08-26T10-20-30-{other_thread}.jsonl");
        assert!(resolve_rollout_path(&format!("{invalid}\n{other}\n"), SESSION).is_err());
    }

    #[test]
    fn rollout_discovery_searches_ordinary_and_reverted_names() {
        let command = codex_rollout_find_command(SESSION);
        assert!(command.contains(&format!("'rollout-*-{SESSION}.jsonl'")));
        assert!(command.contains(&format!("'rollout-*-{SESSION}_*.jsonl'")));
    }

    #[test]
    fn metadata_validation_preserves_file_identity_and_size() {
        assert_eq!(
            parse_metadata("12:34 456\n").unwrap(),
            ("12:34".to_owned(), 456)
        );
        assert!(parse_metadata("bad 456").is_err());
        assert!(parse_metadata("12:34 nope").is_err());
    }

    #[test]
    fn stream_command_matches_the_pre_migration_binary_path() {
        assert_eq!(
            codex_stream_command("/tmp/rollout's file.jsonl", 123),
            "exec tail -c '+124' -F '/tmp/rollout'\\''s file.jsonl'"
        );
    }

    #[test]
    fn two_sessions_and_terminal_bindings_are_independent() {
        let manager = AgentSessionManager::new("host".into(), Arc::new(RwLock::new(None)));
        let second = "22222222-2222-4222-8222-222222222222";
        let (first_key, _) = manager
            .open_codex("terminal-1".into(), SESSION.into(), None)
            .unwrap();
        let (second_key, _) = manager
            .open_codex("terminal-2".into(), second.into(), None)
            .unwrap();
        assert_ne!(first_key, second_key);
        manager.close_terminal("terminal-1");
        assert!(manager.state(&first_key).is_none());
        assert!(manager.state(&second_key).is_some());
    }
}
