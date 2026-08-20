//! Whip's platform-neutral SSH transport.
//!
//! The public boundary keeps a small JSON API for control-plane operations and
//! uses typed UniFFI calls for latency-sensitive terminal traffic. The original
//! C ABI remains available for compatibility with transitional native clients.
//! React Native owns JavaScript callbacks and lifecycle, while this crate owns
//! the Tokio runtime, SSH sessions, host-key verification, and byte streams.

mod herdr_codec;
mod known_hosts;
uniffi::setup_scaffolding!();

use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char};
use std::panic::AssertUnwindSafe;
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::{Duration, Instant};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use futures::{FutureExt, channel::mpsc as futures_mpsc};
use parking_lot::RwLock;
use russh::client;
use russh::keys::{PrivateKeyWithHashAlg, PublicKey};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::runtime::Runtime;
use tokio::sync::{mpsc, watch};
use tokio::{
    fs,
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
};

use crate::known_hosts::{HostKeyDecision, KnownHosts};

type Sessions = RwLock<HashMap<String, Arc<Session>>>;
type EventCallback = unsafe extern "C" fn(*const c_char);
type ResponseCallback = unsafe extern "C" fn(u64, *const c_char);
type Shells = RwLock<HashMap<String, mpsc::Sender<ShellCommand>>>;
type SftpSessions = RwLock<HashMap<String, Arc<SftpSession>>>;
type Streams = RwLock<HashMap<String, mpsc::Sender<StreamCommand>>>;
type Forwards = RwLock<HashMap<(String, u16), watch::Sender<bool>>>;
type Transfers = RwLock<HashMap<(String, &'static str), Arc<AtomicBool>>>;
type Bridges = RwLock<HashMap<(String, String), BridgeHandle>>;
type PreparedBridges = RwLock<HashMap<String, BridgeHandle>>;

static RUNTIME: OnceLock<Result<Runtime, String>> = OnceLock::new();
static SESSIONS: OnceLock<Sessions> = OnceLock::new();
static KNOWN_HOSTS: OnceLock<RwLock<KnownHosts>> = OnceLock::new();
static EVENT_CALLBACK: OnceLock<RwLock<Option<EventCallback>>> = OnceLock::new();
static UNIFFI_EVENT_SINK: OnceLock<RwLock<Option<Arc<dyn WhipSshEventSink>>>> = OnceLock::new();
static SHELLS: OnceLock<Shells> = OnceLock::new();
static SFTP_SESSIONS: OnceLock<SftpSessions> = OnceLock::new();
static STREAMS: OnceLock<Streams> = OnceLock::new();
static FORWARDS: OnceLock<Forwards> = OnceLock::new();
static TRANSFERS: OnceLock<Transfers> = OnceLock::new();
static BRIDGES: OnceLock<Bridges> = OnceLock::new();
static PREPARED_BRIDGES: OnceLock<PreparedBridges> = OnceLock::new();
static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);
static LIFECYCLE_EPOCH: AtomicU64 = AtomicU64::new(1);

const CONTROL_QUEUE_CAPACITY: usize = 256;
const EXECUTE_OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const REMOTE_HOME_COMMAND: &str = r#"printf %s "$HOME""#;

#[derive(Debug, thiserror::Error)]
enum TransportError {
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("unknown client")]
    UnknownClient,
    #[error("authentication failed")]
    AuthenticationFailed,
    #[error("{0}")]
    HostKey(String),
    #[error("{0}")]
    Ssh(#[from] russh::Error),
    #[error("{0}")]
    Key(#[from] russh::keys::Error),
    #[error("{0}")]
    SshKey(#[from] russh::keys::ssh_key::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Sftp(#[from] russh_sftp::client::error::Error),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    operation: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct Response {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl Response {
    fn success(value: Value) -> Self {
        Self {
            ok: true,
            value: Some(value),
            error: None,
        }
    }

    fn failure(error: impl ToString) -> Self {
        Self {
            ok: false,
            value: None,
            error: Some(error.to_string()),
        }
    }
}

#[uniffi::export(with_foreign)]
pub trait WhipSshEventSink: Send + Sync {
    fn emit(&self, event_json: String);
    #[allow(clippy::too_many_arguments)]
    fn terminal_frame(
        &self,
        key: String,
        terminal_id: String,
        sequence: u64,
        width: u32,
        height: u32,
        full: bool,
        bytes: Vec<u8>,
    );
}

struct Session {
    handle: client::Handle<WhipHandler>,
    host: String,
    port: u16,
    agent: Arc<AgentState>,
}

trait AgentIo: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Sync + Unpin {}
impl<T> AgentIo for T where T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Sync + Unpin {}
type AgentSender = futures_mpsc::UnboundedSender<std::io::Result<Box<dyn AgentIo>>>;

#[derive(Default)]
struct AgentState {
    enabled: AtomicBool,
    sender: RwLock<Option<AgentSender>>,
}

#[derive(Clone)]
struct WhipAgent {
    allow_initial_add: Arc<AtomicBool>,
}

impl russh::keys::agent::server::Agent for WhipAgent {
    async fn confirm_request(&self, message: russh::keys::agent::server::MessageType) -> bool {
        match message {
            russh::keys::agent::server::MessageType::RequestKeys
            | russh::keys::agent::server::MessageType::Sign => true,
            russh::keys::agent::server::MessageType::AddKeys => {
                self.allow_initial_add.swap(false, Ordering::Relaxed)
            }
            _ => false,
        }
    }
}

enum ShellCommand {
    Write(Vec<u8>),
    Resize { columns: u32, rows: u32 },
    Close,
}

enum StreamCommand {
    Write(Vec<u8>),
    Close,
}

enum BridgeCommand {
    Attach { terminal_id: String, takeover: bool },
    Send(Vec<u8>),
    Close,
}

#[derive(Clone)]
struct BridgeHandle {
    protocol: u32,
    sender: mpsc::Sender<BridgeCommand>,
}

#[derive(Clone)]
struct WhipHandler {
    host: String,
    port: u16,
    agent: Arc<AgentState>,
}

impl client::Handler for WhipHandler {
    type Error = TransportError;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let decision = known_hosts()
            .read()
            .check(&self.host, self.port, server_public_key);
        match decision {
            HostKeyDecision::Trusted => Ok(true),
            HostKeyDecision::Unknown(challenge) => {
                Err(TransportError::HostKey(challenge.error_message(false)))
            }
            HostKeyDecision::Changed(challenge) => {
                Err(TransportError::HostKey(challenge.error_message(true)))
            }
        }
    }

    fn server_channel_open_agent_forward(
        &mut self,
        channel: russh::Channel<client::Msg>,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send {
        let enabled = self.agent.enabled.load(Ordering::Relaxed);
        let sender = self.agent.sender.read().clone();
        async move {
            let Some(sender) = sender.filter(|_| enabled) else {
                return Ok(());
            };
            reply.accept().await;
            sender
                .unbounded_send(Ok(Box::new(channel.into_stream())))
                .map_err(|_| {
                    TransportError::InvalidRequest("forwarded SSH agent is closed".to_owned())
                })?;
            Ok(())
        }
    }
}

fn runtime() -> Result<&'static Runtime, String> {
    RUNTIME
        .get_or_init(|| Runtime::new().map_err(|error| error.to_string()))
        .as_ref()
        .map_err(Clone::clone)
}

fn sessions() -> &'static Sessions {
    SESSIONS.get_or_init(|| RwLock::new(HashMap::new()))
}

fn known_hosts() -> &'static RwLock<KnownHosts> {
    KNOWN_HOSTS.get_or_init(|| RwLock::new(KnownHosts::default()))
}

fn shells() -> &'static Shells {
    SHELLS.get_or_init(|| RwLock::new(HashMap::new()))
}

fn event_callback() -> &'static RwLock<Option<EventCallback>> {
    EVENT_CALLBACK.get_or_init(|| RwLock::new(None))
}
fn uniffi_event_sink() -> &'static RwLock<Option<Arc<dyn WhipSshEventSink>>> {
    UNIFFI_EVENT_SINK.get_or_init(|| RwLock::new(None))
}
fn sftp_sessions() -> &'static SftpSessions {
    SFTP_SESSIONS.get_or_init(|| RwLock::new(HashMap::new()))
}
fn streams() -> &'static Streams {
    STREAMS.get_or_init(|| RwLock::new(HashMap::new()))
}
fn forwards() -> &'static Forwards {
    FORWARDS.get_or_init(|| RwLock::new(HashMap::new()))
}
fn transfers() -> &'static Transfers {
    TRANSFERS.get_or_init(|| RwLock::new(HashMap::new()))
}

fn bridges() -> &'static Bridges {
    BRIDGES.get_or_init(|| RwLock::new(HashMap::new()))
}

fn prepared_bridges() -> &'static PreparedBridges {
    PREPARED_BRIDGES.get_or_init(|| RwLock::new(HashMap::new()))
}

fn emit_event(value: Value) {
    let Ok(json) = serde_json::to_string(&value) else {
        return;
    };
    let sink = uniffi_event_sink().read().clone();
    let callback = *event_callback().read();
    match (sink, callback) {
        (Some(sink), None) => sink.emit(json),
        (None, Some(callback)) => emit_legacy_json(callback, json),
        (Some(sink), Some(callback)) => {
            sink.emit(json.clone());
            emit_legacy_json(callback, json);
        }
        (None, None) => {}
    }
}

fn emit_legacy_json(callback: EventCallback, json: String) {
    let Ok(json) = CString::new(json) else {
        return;
    };
    // The Objective-C callback copies the string before returning.
    unsafe { callback(json.as_ptr()) };
}

fn required_string(params: &Value, name: &str) -> Result<String, TransportError> {
    params
        .get(name)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| TransportError::InvalidRequest(format!("missing string parameter '{name}'")))
}

fn required_u16(params: &Value, name: &str) -> Result<u16, TransportError> {
    let number = params.get(name).and_then(Value::as_u64).ok_or_else(|| {
        TransportError::InvalidRequest(format!("missing integer parameter '{name}'"))
    })?;
    u16::try_from(number).map_err(|_| {
        TransportError::InvalidRequest(format!("parameter '{name}' is outside the port range"))
    })
}

fn key_details(params: &Value) -> Result<Value, TransportError> {
    let private_key = required_string(params, "privateKey")?;
    let passphrase = params.get("passphrase").and_then(Value::as_str);
    let key = russh::keys::decode_secret_key(&private_key, passphrase)?;
    let public_key = key.public_key();
    let key_size = match public_key.algorithm() {
        russh::keys::Algorithm::Ed25519 => 256,
        russh::keys::Algorithm::Ecdsa { curve } => match curve {
            russh::keys::EcdsaCurve::NistP256 => 256,
            russh::keys::EcdsaCurve::NistP384 => 384,
            russh::keys::EcdsaCurve::NistP521 => 521,
        },
        russh::keys::Algorithm::Rsa { .. } => public_key
            .key_data()
            .rsa()
            .map(|key| key.key_size())
            .unwrap_or_default(),
        _ => 0,
    };
    Ok(json!({
        "keyType": public_key.algorithm().as_str(),
        "keySize": key_size,
        "fingerprint": public_key.fingerprint(russh::keys::HashAlg::Sha256).to_string(),
        "publicKey": public_key.to_openssh()?,
    }))
}

fn generate_key_pair(params: &Value) -> Result<Value, TransportError> {
    let key_type = required_string(params, "type")?;
    if key_type != "ed25519" && key_type != "ssh-ed25519" {
        return Err(TransportError::InvalidRequest(
            "the iOS Rust preview currently generates Ed25519 keys only".to_owned(),
        ));
    }
    let passphrase = params
        .get("passphrase")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let comment = params
        .get("comment")
        .and_then(Value::as_str)
        .unwrap_or("whip");
    let mut rng =
        russh::keys::ssh_key::rand_core::UnwrapErr(russh::keys::ssh_key::getrandom::SysRng);
    let mut private_key =
        russh::keys::PrivateKey::random(&mut rng, russh::keys::Algorithm::Ed25519)?;
    private_key.set_comment(comment);
    let public_key = private_key.public_key().to_openssh()?;
    if !passphrase.is_empty() {
        private_key =
            private_key.encrypt(&mut russh::keys::ssh_key::getrandom::SysRng, passphrase)?;
    }
    let private_key = private_key
        .to_openssh(russh::keys::ssh_key::LineEnding::LF)?
        .to_string();
    Ok(json!({ "privateKey": private_key, "publicKey": public_key }))
}

async fn initialize_agent(
    private_key: Arc<russh::keys::PrivateKey>,
    state: Arc<AgentState>,
) -> Result<(), TransportError> {
    let (sender, receiver) = futures_mpsc::unbounded::<std::io::Result<Box<dyn AgentIo>>>();
    let agent_policy = WhipAgent {
        allow_initial_add: Arc::new(AtomicBool::new(true)),
    };
    tokio::spawn(async move {
        let _ = russh::keys::agent::server::serve(receiver, agent_policy).await;
    });

    // Seed the private key into the in-process agent over the same protocol
    // used by forwarded clients. The remote side can list and sign with it,
    // but WhipAgent rejects add/remove/lock requests.
    let (client_stream, server_stream) = tokio::io::duplex(256 * 1024);
    sender
        .unbounded_send(Ok(Box::new(server_stream)))
        .map_err(|_| TransportError::InvalidRequest("could not start SSH agent".to_owned()))?;
    let mut agent = russh::keys::agent::client::AgentClient::connect(client_stream);
    agent.add_identity(&private_key, &[]).await?;
    *state.sender.write() = Some(sender);
    Ok(())
}

async fn connect(params: &Value) -> Result<Value, TransportError> {
    let key = required_string(params, "key")?;
    let host = required_string(params, "host")?;
    let port = required_u16(params, "port")?;
    let username = required_string(params, "username")?;
    let credential = params
        .get("credential")
        .ok_or_else(|| TransportError::InvalidRequest("missing credential parameter".to_owned()))?;
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        ..Default::default()
    });
    let agent = Arc::new(AgentState::default());
    let handler = WhipHandler {
        host: host.clone(),
        port,
        agent: agent.clone(),
    };
    let mut handle = if let Some(jump_key) = params.get("jumpKey").and_then(Value::as_str) {
        let jump = sessions().read().get(jump_key).cloned().ok_or_else(|| {
            TransportError::InvalidRequest("jump host SSH connection is not active".to_owned())
        })?;
        let channel = jump
            .handle
            .channel_open_direct_tcpip(host.clone(), port as u32, "127.0.0.1", 0)
            .await?;
        client::connect_stream(config, channel.into_stream(), handler).await?
    } else {
        client::connect(config, (host.as_str(), port), handler).await?
    };

    let mut forwarding_key = None;
    let authenticated = match credential.get("type").and_then(Value::as_str) {
        Some("password") => {
            let password = required_string(credential, "password")?;
            authenticate_password(&mut handle, &username, &password).await?
        }
        Some("key") => {
            let private_key = required_string(credential, "privateKey")?;
            let passphrase = credential.get("passphrase").and_then(Value::as_str);
            let key_pair = Arc::new(russh::keys::decode_secret_key(&private_key, passphrase)?);
            let hash_alg = handle.best_supported_rsa_hash().await?.flatten();
            let auth_key = PrivateKeyWithHashAlg::new(key_pair.clone(), hash_alg);
            let result = handle
                .authenticate_publickey(&username, auth_key)
                .await?
                .success();
            if result {
                forwarding_key = Some(key_pair);
            }
            result
        }
        _ => {
            return Err(TransportError::InvalidRequest(
                "credential.type must be 'password' or 'key'".to_owned(),
            ));
        }
    };
    if !authenticated {
        return Err(TransportError::AuthenticationFailed);
    }
    if let Some(private_key) = forwarding_key {
        initialize_agent(private_key, agent.clone()).await?;
    }
    sessions().write().insert(
        key,
        Arc::new(Session {
            handle,
            host,
            port,
            agent,
        }),
    );
    Ok(Value::Null)
}

async fn authenticate_password(
    handle: &mut client::Handle<WhipHandler>,
    username: &str,
    password: &str,
) -> Result<bool, TransportError> {
    if handle
        .authenticate_password(username, password)
        .await?
        .success()
    {
        return Ok(true);
    }

    // macOS and other PAM-backed SSH servers commonly present a password
    // through keyboard-interactive authentication. OpenSSH clients fall back
    // automatically, so mirror that behavior without answering unknown MFA
    // or challenge prompts.
    let mut response = handle
        .authenticate_keyboard_interactive_start(username, None)
        .await?;
    for _ in 0..3 {
        match response {
            client::KeyboardInteractiveAuthResponse::Success => return Ok(true),
            client::KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            client::KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let Some(responses) =
                    keyboard_interactive_password_responses(&prompts, username, password)
                else {
                    return Ok(false);
                };
                response = handle
                    .authenticate_keyboard_interactive_respond(responses)
                    .await?;
            }
        }
    }
    Ok(false)
}

fn keyboard_interactive_password_responses(
    prompts: &[client::Prompt],
    username: &str,
    password: &str,
) -> Option<Vec<String>> {
    prompts
        .iter()
        .map(|prompt| {
            let label = prompt.prompt.to_ascii_lowercase();
            if prompt.echo && (label.contains("user") || label.contains("login")) {
                Some(username.to_owned())
            } else if !prompt.echo && (label.contains("password") || prompts.len() == 1) {
                Some(password.to_owned())
            } else {
                None
            }
        })
        .collect()
}

async fn request_agent_forwarding(
    session: &Session,
    channel: &russh::Channel<client::Msg>,
) -> Result<(), TransportError> {
    if session.agent.enabled.load(Ordering::Relaxed) {
        channel.agent_forward(true).await?;
    }
    Ok(())
}

fn append_capped(destination: &mut Vec<u8>, source: &[u8]) -> bool {
    let remaining = EXECUTE_OUTPUT_LIMIT.saturating_sub(destination.len());
    destination.extend_from_slice(&source[..source.len().min(remaining)]);
    source.len() > remaining
}

async fn execute(params: &Value) -> Result<Value, TransportError> {
    let key = required_string(params, "key")?;
    let command = required_string(params, "command")?;
    let session = sessions()
        .read()
        .get(&key)
        .cloned()
        .ok_or(TransportError::UnknownClient)?;
    let mut channel = session.handle.channel_open_session().await?;
    request_agent_forwarding(&session, &channel).await?;
    channel.exec(true, command).await?;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut stdout_truncated = false;
    let mut stderr_truncated = false;
    let mut exit_status = None;
    while let Some(message) = channel.wait().await {
        match message {
            russh::ChannelMsg::Data { data } => {
                stdout_truncated |= append_capped(&mut stdout, &data)
            }
            russh::ChannelMsg::ExtendedData { data, ext: 1 } => {
                stderr_truncated |= append_capped(&mut stderr, &data)
            }
            russh::ChannelMsg::ExitStatus {
                exit_status: status,
            } => exit_status = Some(status),
            _ => {}
        }
    }
    if stdout_truncated {
        stdout.extend_from_slice(b"\n[Whip: stdout truncated at 8 MiB]\n");
    }
    if stderr_truncated {
        stderr.extend_from_slice(b"\n[Whip: stderr truncated at 8 MiB]\n");
    }
    Ok(json!({
        "stdout": String::from_utf8_lossy(&stdout),
        "stderr": String::from_utf8_lossy(&stderr),
        "exitStatus": exit_status,
        "stdoutTruncated": stdout_truncated,
        "stderrTruncated": stderr_truncated,
    }))
}

async fn latency(params: &Value) -> Result<Value, TransportError> {
    let key = required_string(params, "key")?;
    let session = sessions()
        .read()
        .get(&key)
        .cloned()
        .ok_or(TransportError::UnknownClient)?;
    let start = Instant::now();
    let mut channel = session.handle.channel_open_session().await?;
    channel.exec(true, "true").await?;
    while channel.wait().await.is_some() {}
    Ok(json!(start.elapsed().as_secs_f64() * 1000.0))
}

async fn start_shell(params: &Value) -> Result<Value, TransportError> {
    let key = required_string(params, "key")?;
    let pty_type = params
        .get("ptyType")
        .and_then(Value::as_str)
        .unwrap_or("xterm-256color");
    let columns = params.get("columns").and_then(Value::as_u64).unwrap_or(80) as u32;
    let rows = params.get("rows").and_then(Value::as_u64).unwrap_or(24) as u32;
    let session = sessions()
        .read()
        .get(&key)
        .cloned()
        .ok_or(TransportError::UnknownClient)?;
    let mut channel = session.handle.channel_open_session().await?;
    channel
        .request_pty(false, pty_type, columns, rows, 0, 0, &[])
        .await?;
    request_agent_forwarding(&session, &channel).await?;
    channel.request_shell(true).await?;
    let (sender, mut receiver) = mpsc::channel(CONTROL_QUEUE_CAPACITY);
    shells().write().insert(key.clone(), sender);
    tokio::spawn(async move {
        loop {
            tokio::select! {
                message = channel.wait() => match message {
                    Some(russh::ChannelMsg::Data { data }) => {
                        emit_event(json!({
                            "name": "Shell",
                            "key": key,
                            "value": String::from_utf8_lossy(&data),
                        }));
                    }
                    Some(russh::ChannelMsg::ExtendedData { data, .. }) => {
                        emit_event(json!({
                            "name": "Shell",
                            "key": key,
                            "value": String::from_utf8_lossy(&data),
                        }));
                    }
                    Some(russh::ChannelMsg::Eof | russh::ChannelMsg::Close) | None => break,
                    _ => {}
                },
                command = receiver.recv() => match command {
                    Some(ShellCommand::Write(data)) => {
                        if channel.data(&data[..]).await.is_err() { break; }
                    }
                    Some(ShellCommand::Resize { columns, rows }) => {
                        if channel.window_change(columns, rows, 0, 0).await.is_err() { break; }
                    }
                    Some(ShellCommand::Close) | None => {
                        let _ = channel.eof().await;
                        let _ = channel.close().await;
                        break;
                    }
                }
            }
        }
        shells().write().remove(&key);
        emit_event(json!({ "name": "ShellClosed", "key": key }));
    });
    Ok(Value::Null)
}

fn shell_command(params: &Value, command: ShellCommand) -> Result<Value, TransportError> {
    let key = required_string(params, "key")?;
    shell_command_for_key(&key, command)?;
    Ok(Value::Null)
}

fn shell_command_for_key(key: &str, command: ShellCommand) -> Result<(), TransportError> {
    let sender = shells()
        .read()
        .get(key)
        .cloned()
        .ok_or(TransportError::UnknownClient)?;
    sender.try_send(command).map_err(|error| {
        TransportError::InvalidRequest(format!("shell control queue rejected input: {error}"))
    })?;
    Ok(())
}

fn session_for(params: &Value) -> Result<Arc<Session>, TransportError> {
    let key = required_string(params, "key")?;
    sessions()
        .read()
        .get(&key)
        .cloned()
        .ok_or(TransportError::UnknownClient)
}

async fn connect_sftp(params: &Value) -> Result<Value, TransportError> {
    let key = required_string(params, "key")?;
    if sftp_sessions().read().contains_key(&key) {
        return Ok(Value::Null);
    }
    let session = session_for(params)?;
    let channel = session.handle.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    let sftp = SftpSession::new(channel.into_stream()).await?;
    sftp_sessions().write().insert(key, Arc::new(sftp));
    Ok(Value::Null)
}

fn sftp_for(params: &Value) -> Result<(String, Arc<SftpSession>), TransportError> {
    let key = required_string(params, "key")?;
    let sftp = sftp_sessions()
        .read()
        .get(&key)
        .cloned()
        .ok_or_else(|| TransportError::InvalidRequest("SFTP is not connected".to_owned()))?;
    Ok((key, sftp))
}

async fn sftp_list(params: &Value) -> Result<Value, TransportError> {
    let (_, sftp) = sftp_for(params)?;
    let path = required_string(params, "path")?;
    let entries = sftp
        .read_dir(path)
        .await?
        .map(|entry| {
            let metadata = entry.metadata();
            let mut filename = entry.file_name();
            let is_directory = metadata.is_dir();
            if is_directory {
                filename.push('/');
            }
            json!({
                "filename": filename,
                "isDirectory": if is_directory { 1 } else { 0 },
                "modificationDate": metadata.mtime.unwrap_or_default().to_string(),
                "lastAccess": metadata.atime.unwrap_or_default().to_string(),
                "fileSize": metadata.size.unwrap_or_default(),
                "ownerUserID": metadata.uid.unwrap_or_default(),
                "ownerGroupID": metadata.gid.unwrap_or_default(),
                "permissions": metadata.permissions.unwrap_or_default().to_string(),
                "flags": 0,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!(entries))
}

async fn sftp_mutation(params: &Value, operation: &str) -> Result<Value, TransportError> {
    let (_, sftp) = sftp_for(params)?;
    let path = required_string(params, "path")?;
    match operation {
        "mkdir" => sftp.create_dir(path).await?,
        "rm" => sftp.remove_file(path).await?,
        "rmdir" => sftp.remove_dir(path).await?,
        "chmod" => {
            let mut metadata = sftp.metadata(path.clone()).await?;
            let requested = params
                .get("permissions")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| {
                    TransportError::InvalidRequest(
                        "missing integer parameter 'permissions'".to_owned(),
                    )
                })?;
            let file_type = metadata.permissions.unwrap_or_default() & !0o7777;
            metadata.permissions = Some(file_type | (requested & 0o7777));
            sftp.set_metadata(path, metadata).await?;
        }
        _ => {
            return Err(TransportError::InvalidRequest(format!(
                "unsupported SFTP mutation '{operation}'"
            )));
        }
    }
    Ok(Value::Null)
}

async fn sftp_transfer(params: &Value, upload: bool) -> Result<Value, TransportError> {
    let (key, sftp) = sftp_for(params)?;
    let local = required_string(params, "localPath")?;
    let remote = required_string(params, "remotePath")?;
    let direction = if upload { "upload" } else { "download" };
    let event = if upload {
        "UploadProgress"
    } else {
        "DownloadProgress"
    };
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = transfers().write();
        if active.contains_key(&(key.clone(), direction)) {
            return Err(TransportError::InvalidRequest(format!(
                "an SFTP {direction} is already active for this connection"
            )));
        }
        active.insert((key.clone(), direction), cancel.clone());
    }
    let result: Result<String, TransportError> = async {
        let copy = async |mut source: Box<dyn tokio::io::AsyncRead + Unpin + Send>,
                          mut destination: Box<dyn tokio::io::AsyncWrite + Unpin + Send>,
                          total: u64|
               -> Result<(), TransportError> {
            let mut copied = 0u64;
            let mut last_percent = None;
            let mut buffer = vec![0u8; 64 * 1024];
            loop {
                if cancel.load(Ordering::Relaxed) {
                    return Err(TransportError::InvalidRequest(format!(
                        "SFTP {direction} cancelled"
                    )));
                }
                let count = source.read(&mut buffer).await?;
                if count == 0 {
                    break;
                }
                destination.write_all(&buffer[..count]).await?;
                copied += count as u64;
                let percent = copied.saturating_mul(100).checked_div(total).unwrap_or(100);
                if last_percent != Some(percent) {
                    emit_event(json!({ "name": event, "key": key, "value": percent.to_string() }));
                    last_percent = Some(percent);
                }
            }
            destination.shutdown().await?;
            if last_percent != Some(100) {
                emit_event(json!({ "name": event, "key": key, "value": "100" }));
            }
            Ok(())
        };

        if upload {
            let source = fs::File::open(&local).await?;
            let total = source.metadata().await?.len();
            let filename = std::path::Path::new(&local)
                .file_name()
                .and_then(|v| v.to_str())
                .ok_or_else(|| {
                    TransportError::InvalidRequest("local path has no filename".to_owned())
                })?;
            let destination_path = format!("{}/{}", remote.trim_end_matches('/'), filename);
            let transfer_id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
            let temp_path = format!("{destination_path}.whip-part-{transfer_id}");
            let destination = sftp.create(temp_path.clone()).await?;
            let copied = copy(Box::new(source), Box::new(destination), total).await;
            if let Err(error) = copied {
                let _ = sftp.remove_file(temp_path).await;
                return Err(error);
            }
            // Standard SFTP rename does not replace existing files on every
            // server. Preserve the prior file until the complete upload exists,
            // and restore it if the final rename fails.
            let backup_path = format!("{destination_path}.whip-backup-{transfer_id}");
            let had_prior_file = sftp.metadata(destination_path.clone()).await.is_ok();
            if had_prior_file {
                sftp.rename(destination_path.clone(), backup_path.clone())
                    .await?;
            }
            if let Err(error) = sftp
                .rename(temp_path.clone(), destination_path.clone())
                .await
            {
                let _ = sftp.remove_file(temp_path).await;
                if had_prior_file {
                    let _ = sftp.rename(backup_path, destination_path).await;
                }
                return Err(error.into());
            }
            if had_prior_file {
                let _ = sftp.remove_file(backup_path).await;
            }
            Ok(String::new())
        } else {
            let source = sftp.open(&remote).await?;
            let total = source.metadata().await?.size.unwrap_or_default();
            let filename = std::path::Path::new(&remote)
                .file_name()
                .and_then(|v| v.to_str())
                .ok_or_else(|| {
                    TransportError::InvalidRequest("remote path has no filename".to_owned())
                })?;
            let destination_path = format!("{}/{}", local.trim_end_matches('/'), filename);
            let temp_path = format!(
                "{destination_path}.whip-part-{}",
                NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed)
            );
            let destination = fs::File::create(&temp_path).await?;
            let copied = copy(Box::new(source), Box::new(destination), total).await;
            if let Err(error) = copied {
                let _ = fs::remove_file(temp_path).await;
                return Err(error);
            }
            if let Err(error) = fs::rename(&temp_path, &destination_path).await {
                let _ = fs::remove_file(temp_path).await;
                return Err(error.into());
            }
            Ok(destination_path)
        }
    }
    .await;
    transfers().write().remove(&(key, direction));
    result.map(Value::String)
}

async fn request_streamlocal(params: &Value) -> Result<Value, TransportError> {
    let session = session_for(params)?;
    let socket_path = required_string(params, "socketPath")?;
    let request = required_string(params, "request")?;
    let channel = session
        .handle
        .channel_open_direct_streamlocal(socket_path)
        .await?;
    let mut stream = BufReader::new(channel.into_stream());
    stream.write_all(request.as_bytes()).await?;
    let mut response = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(15),
        stream.read_until(b'\n', &mut response),
    )
    .await
    .map_err(|_| {
        TransportError::InvalidRequest("timed out waiting for Herdr API response".to_owned())
    })??;
    Ok(json!(
        String::from_utf8_lossy(&response).trim_end_matches(['\r', '\n'])
    ))
}

async fn open_local_forward(params: &Value) -> Result<Value, TransportError> {
    let key = required_string(params, "key")?;
    let remote_host = required_string(params, "remoteHost")?;
    let remote_port = required_u16(params, "remotePort")?;
    let session = session_for(params)?;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let local_port = listener.local_addr()?.port();
    let (cancel_tx, mut cancel_rx) = watch::channel(false);
    forwards()
        .write()
        .insert((key.clone(), local_port), cancel_tx.clone());
    tokio::spawn(async move {
        loop {
            tokio::select! {
                changed = cancel_rx.changed() => {
                    if changed.is_err() || *cancel_rx.borrow() { break; }
                },
                accepted = listener.accept() => {
                    let Ok((mut local, _)) = accepted else { break };
                    let Ok(channel) = session.handle.channel_open_direct_tcpip(remote_host.clone(), remote_port as u32, "127.0.0.1", local_port as u32).await else { continue };
                    let mut tunnel_cancel = cancel_rx.clone();
                    tokio::spawn(async move {
                        let mut remote = channel.into_stream();
                        tokio::select! {
                            _ = tunnel_cancel.changed() => {},
                            _ = tokio::io::copy_bidirectional(&mut local, &mut remote) => {},
                        }
                    });
                }
            }
        }
        let map_key = (key, local_port);
        let should_remove = forwards()
            .read()
            .get(&map_key)
            .is_some_and(|current| current.same_channel(&cancel_tx));
        if should_remove {
            forwards().write().remove(&map_key);
        }
    });
    Ok(json!(local_port))
}

async fn start_stream(params: &Value, command_stream: bool) -> Result<Value, TransportError> {
    let key = required_string(params, "key")?;
    let stream_key = format!(
        "{}:{}",
        key,
        if command_stream { "command" } else { "event" }
    );
    if streams().read().contains_key(&stream_key) {
        return Ok(Value::Null);
    }
    let session = session_for(params)?;
    let channel = if command_stream {
        let channel = session.handle.channel_open_session().await?;
        request_agent_forwarding(&session, &channel).await?;
        channel
            .exec(true, required_string(params, "command")?)
            .await?;
        channel
    } else {
        session
            .handle
            .channel_open_direct_streamlocal(required_string(params, "socketPath")?)
            .await?
    };
    let event_name = if command_stream {
        "HerdrCommandStream"
    } else {
        "HerdrEventStream"
    };
    let (sender, mut receiver) = mpsc::channel(CONTROL_QUEUE_CAPACITY);
    streams().write().insert(stream_key.clone(), sender);
    tokio::spawn(async move {
        let mut stream = channel.into_stream();
        let mut buffer = vec![0u8; 8192];
        loop {
            tokio::select! {
                read = stream.read(&mut buffer) => match read {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        let data = String::from_utf8_lossy(&buffer[..count]);
                        let value = if command_stream { json!({"data": data, "closed": false}) } else { json!(data) };
                        emit_event(json!({"name": event_name, "key": key, "value": value}));
                    }
                },
                command = receiver.recv() => match command {
                    Some(StreamCommand::Write(data)) => if stream.write_all(&data).await.is_err() { break },
                    Some(StreamCommand::Close) | None => break,
                }
            }
        }
        let value = if command_stream {
            json!({"closed": true})
        } else {
            json!("{\"herdr_android_bridge_closed\":true}\n")
        };
        emit_event(json!({"name": event_name, "key": key, "value": value}));
        streams().write().remove(&stream_key);
    });
    Ok(Value::Null)
}

fn stream_command(
    params: &Value,
    command_stream: bool,
    command: StreamCommand,
) -> Result<Value, TransportError> {
    let key = required_string(params, "key")?;
    let stream_key = format!(
        "{}:{}",
        key,
        if command_stream { "command" } else { "event" }
    );
    let sender = streams()
        .read()
        .get(&stream_key)
        .cloned()
        .ok_or_else(|| TransportError::InvalidRequest("stream is not active".to_owned()))?;
    sender.try_send(command).map_err(|error| {
        TransportError::InvalidRequest(format!("stream control queue rejected input: {error}"))
    })?;
    Ok(Value::Null)
}

fn required_u32(params: &Value, name: &str, fallback: Option<u32>) -> Result<u32, TransportError> {
    match params.get(name).and_then(Value::as_u64) {
        Some(value) => u32::try_from(value)
            .map_err(|_| TransportError::InvalidRequest(format!("parameter '{name}' exceeds u32"))),
        None => fallback.ok_or_else(|| {
            TransportError::InvalidRequest(format!("missing integer parameter '{name}'"))
        }),
    }
}

async fn read_bridge_frame<R>(reader: &mut R) -> Result<Option<Vec<u8>>, TransportError>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut length = [0u8; 4];
    let first = reader.read(&mut length[..1]).await?;
    if first == 0 {
        return Ok(None);
    }
    reader.read_exact(&mut length[1..]).await?;
    let length = u32::from_le_bytes(length) as usize;
    if length > herdr_codec::MAX_FRAME_SIZE {
        return Err(TransportError::InvalidRequest(format!(
            "Herdr bridge frame exceeds maximum size: {length}"
        )));
    }
    let mut payload = vec![0; length];
    reader.read_exact(&mut payload).await?;
    Ok(Some(payload))
}

fn herdr_bridge_event(key: &str, terminal_id: &str, message: herdr_codec::Message) {
    if message.kind == "terminal" {
        let sink = uniffi_event_sink().read().clone();
        let callback = *event_callback().read();
        if callback.is_none() {
            if let Some(sink) = sink {
                sink.terminal_frame(
                    key.to_owned(),
                    terminal_id.to_owned(),
                    message.sequence,
                    message.width,
                    message.height,
                    message.flag,
                    message.bytes,
                );
            }
            return;
        }
        if let Some(sink) = sink {
            sink.terminal_frame(
                key.to_owned(),
                terminal_id.to_owned(),
                message.sequence,
                message.width,
                message.height,
                message.flag,
                message.bytes.clone(),
            );
        }

        // Only transitional C-ABI clients need the base64 JSON representation.
        if let Some(callback) = callback {
            let chunks = message.bytes.chunks(6144).collect::<Vec<_>>();
            let last = chunks.len().saturating_sub(1);
            if chunks.is_empty() {
                emit_legacy_json(
                    callback,
                    serde_json::to_string(&json!({
                        "name": "HerdrBridge", "key": key,
                        "value": {"type": "terminal", "terminalId": terminal_id,
                            "seq": message.sequence, "width": message.width,
                            "height": message.height, "full": message.flag,
                            "bytes": "", "final": true}
                    }))
                    .unwrap_or_default(),
                );
            }
            for (index, chunk) in chunks.into_iter().enumerate() {
                let event = json!({
                "name": "HerdrBridge", "key": key,
                "value": {"type": "terminal", "terminalId": terminal_id,
                    "seq": message.sequence, "width": message.width,
                    "height": message.height, "full": message.flag,
                    "bytes": BASE64.encode(chunk), "final": index == last}
                });
                if let Ok(json) = serde_json::to_string(&event) {
                    emit_legacy_json(callback, json);
                }
            }
        }
        return;
    }

    let mut value = json!({
        "type": message.kind,
        "terminalId": terminal_id,
        "flag": message.flag,
        "kind": message.width,
    });
    if let Some(text) = message.text {
        value["text"] = json!(text);
    }
    if let Some(body) = message.body {
        value["body"] = json!(body);
    }
    if message.kind == "terminal_bell" {
        value["count"] = json!(message.count);
    }
    emit_event(json!({"name": "HerdrBridge", "key": key, "value": value}));
}

fn herdr_bridge_closed(key: &str, terminal_id: &str, reason: impl ToString) {
    emit_event(json!({
        "name": "HerdrBridge", "key": key,
        "value": {"type": "closed", "terminalId": terminal_id, "text": reason.to_string()}
    }));
}

async fn create_bridge(
    params: &Value,
    socket_path: String,
    terminal: Option<(String, bool)>,
) -> Result<BridgeHandle, TransportError> {
    let key = required_string(params, "key")?;
    let protocol = required_u32(params, "protocol", None)?;
    let columns = required_u32(params, "columns", Some(80))?;
    let rows = required_u32(params, "rows", Some(24))?;
    let cell_width = required_u32(params, "cellWidthPx", Some(0))?;
    let cell_height = required_u32(params, "cellHeightPx", Some(0))?;
    let session = session_for(params)?;
    let channel = session
        .handle
        .channel_open_direct_streamlocal(socket_path)
        .await?;
    let mut stream = channel.into_stream();
    let hello = herdr_codec::hello(protocol, columns, rows, cell_width, cell_height)
        .map_err(TransportError::InvalidRequest)?;
    stream.write_all(&hello).await?;
    let payload = tokio::time::timeout(Duration::from_secs(15), read_bridge_frame(&mut stream))
        .await
        .map_err(|_| {
            TransportError::InvalidRequest("timed out waiting for Herdr Welcome".to_owned())
        })??
        .ok_or_else(|| {
            TransportError::InvalidRequest("Herdr bridge closed before Welcome".to_owned())
        })?;
    let welcome =
        herdr_codec::decode(&payload, protocol).map_err(TransportError::InvalidRequest)?;
    if welcome.kind != "welcome" {
        return Err(TransportError::InvalidRequest(
            "Herdr bridge did not send Welcome first".to_owned(),
        ));
    }
    if let Some(error) = welcome.text {
        return Err(TransportError::InvalidRequest(format!(
            "Herdr bridge rejected protocol {protocol}: {error}"
        )));
    }
    if welcome.sequence != protocol as u64 || welcome.width != 1 {
        return Err(TransportError::InvalidRequest(format!(
            "Herdr bridge negotiation mismatch (protocol {}, encoding {})",
            welcome.sequence, welcome.width
        )));
    }
    if let Some((terminal_id, takeover)) = &terminal {
        stream
            .write_all(&herdr_codec::attach(terminal_id, *takeover))
            .await?;
    }

    let (sender, mut receiver) = mpsc::channel(CONTROL_QUEUE_CAPACITY);
    let handle = BridgeHandle {
        protocol,
        sender: sender.clone(),
    };
    tokio::spawn(async move {
        let (mut reader, mut writer) = tokio::io::split(stream);
        let mut terminal_id = terminal.map(|value| value.0);
        let mut closed_by_client = false;
        loop {
            tokio::select! {
                frame = read_bridge_frame(&mut reader) => match frame {
                    Ok(Some(payload)) => match herdr_codec::decode(&payload, protocol) {
                        Ok(message) => {
                            if let Some(id) = &terminal_id {
                                let closed = message.kind == "closed";
                                herdr_bridge_event(&key, id, message);
                                if closed { break; }
                            }
                        }
                        Err(error) => {
                            if let Some(id) = &terminal_id { herdr_bridge_closed(&key, id, error); }
                            break;
                        }
                    },
                    Ok(None) => break,
                    Err(error) => {
                        if let Some(id) = &terminal_id { herdr_bridge_closed(&key, id, error); }
                        break;
                    }
                },
                command = receiver.recv() => match command {
                    Some(BridgeCommand::Attach { terminal_id: id, takeover }) => {
                        if writer.write_all(&herdr_codec::attach(&id, takeover)).await.is_err() { break; }
                        terminal_id = Some(id);
                    }
                    Some(BridgeCommand::Send(frame)) => if writer.write_all(&frame).await.is_err() { break; },
                    Some(BridgeCommand::Close) | None => {
                        closed_by_client = true;
                        let _ = writer.write_all(&herdr_codec::detach()).await;
                        break;
                    }
                }
            }
        }
        if let Some(id) = &terminal_id {
            let map_key = (key.clone(), id.clone());
            let should_remove = bridges()
                .read()
                .get(&map_key)
                .is_some_and(|current| current.sender.same_channel(&sender));
            if should_remove {
                bridges().write().remove(&map_key);
            }
            if !closed_by_client {
                herdr_bridge_closed(&key, id, "Herdr remote-client-bridge closed");
            }
        } else {
            let should_remove = prepared_bridges()
                .read()
                .get(&key)
                .is_some_and(|current| current.sender.same_channel(&sender));
            if should_remove {
                prepared_bridges().write().remove(&key);
            }
        }
    });
    Ok(handle)
}

async fn prepare_bridge(params: &Value) -> Result<Value, TransportError> {
    let key = required_string(params, "key")?;
    if prepared_bridges().read().contains_key(&key) {
        return Ok(Value::Null);
    }
    let socket_path = required_string(params, "command")?;
    let handle = create_bridge(params, socket_path, None).await?;
    prepared_bridges().write().insert(key, handle);
    Ok(Value::Null)
}

async fn start_bridge(params: &Value) -> Result<Value, TransportError> {
    let key = required_string(params, "key")?;
    let terminal_id = required_string(params, "terminalId")?;
    let protocol = required_u32(params, "protocol", None)?;
    let takeover = params
        .get("takeover")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let map_key = (key.clone(), terminal_id.clone());
    if bridges().read().contains_key(&map_key) {
        return Ok(Value::Null);
    }
    if let Some(prepared) = prepared_bridges().write().remove(&key) {
        if prepared.protocol == protocol
            && prepared
                .sender
                .try_send(BridgeCommand::Attach {
                    terminal_id: terminal_id.clone(),
                    takeover,
                })
                .is_ok()
        {
            bridges().write().insert(map_key, prepared);
            return Ok(Value::Null);
        }
        let _ = prepared.sender.try_send(BridgeCommand::Close);
    }
    let socket_path = required_string(params, "socketPath")?;
    let handle = create_bridge(params, socket_path, Some((terminal_id, takeover))).await?;
    bridges().write().insert(map_key, handle);
    Ok(Value::Null)
}

fn bridge_command(params: &Value, command: BridgeCommand) -> Result<Value, TransportError> {
    let key = required_string(params, "key")?;
    let terminal_id = required_string(params, "terminalId")?;
    bridge_command_for_key(&key, &terminal_id, command)?;
    Ok(Value::Null)
}

fn bridge_command_for_key(
    key: &str,
    terminal_id: &str,
    command: BridgeCommand,
) -> Result<(), TransportError> {
    let handle = bridges()
        .read()
        .get(&(key.to_owned(), terminal_id.to_owned()))
        .cloned()
        .ok_or_else(|| {
            TransportError::InvalidRequest(format!(
                "Herdr bridge is not active for terminal {terminal_id}"
            ))
        })?;
    handle.sender.try_send(command).map_err(|error| {
        TransportError::InvalidRequest(format!(
            "Herdr bridge queue rejected input for terminal {terminal_id}: {error}"
        ))
    })?;
    Ok(())
}

fn close_all_bridges(key: &str) {
    if let Some(prepared) = prepared_bridges().write().remove(key) {
        let _ = prepared.sender.try_send(BridgeCommand::Close);
    }
    let owned = bridges()
        .read()
        .keys()
        .filter(|(owner, _)| owner == key)
        .cloned()
        .collect::<Vec<_>>();
    for map_key in owned {
        if let Some(handle) = bridges().write().remove(&map_key) {
            let _ = handle.sender.try_send(BridgeCommand::Close);
        }
    }
}

async fn disconnect_key(key: String) {
    close_all_bridges(&key);
    if let Some(cancel) = transfers().read().get(&(key.clone(), "upload")) {
        cancel.store(true, Ordering::Relaxed);
    }
    if let Some(cancel) = transfers().read().get(&(key.clone(), "download")) {
        cancel.store(true, Ordering::Relaxed);
    }
    if let Some(sender) = shells().write().remove(&key) {
        let _ = sender.try_send(ShellCommand::Close);
    }
    let removed_sftp = { sftp_sessions().write().remove(&key) };
    if let Some(sftp) = removed_sftp {
        let _ = sftp.close().await;
    }
    for suffix in ["event", "command"] {
        if let Some(sender) = streams().write().remove(&format!("{key}:{suffix}")) {
            let _ = sender.try_send(StreamCommand::Close);
        }
    }
    let ports = forwards()
        .read()
        .keys()
        .filter_map(|(owner, port)| (owner == &key).then_some(*port))
        .collect::<Vec<_>>();
    for port in ports {
        if let Some(cancel) = forwards().write().remove(&(key.clone(), port)) {
            let _ = cancel.send(true);
        }
    }
    let removed_session = { sessions().write().remove(&key) };
    if let Some(session) = removed_session {
        let _ = session
            .handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }
}

async fn shutdown_all() {
    let keys = sessions().read().keys().cloned().collect::<Vec<_>>();
    for key in keys {
        disconnect_key(key).await;
    }
    *known_hosts().write() = KnownHosts::default();
}

async fn dispatch(request: Request) -> Result<Value, TransportError> {
    match request.operation.as_str() {
        "setKnownHosts" => {
            let contents = required_string(&request.params, "contents")?;
            *known_hosts().write() = KnownHosts::parse(&contents);
            Ok(Value::Null)
        }
        "getKeyDetails" => key_details(&request.params),
        "generateKeyPair" => generate_key_pair(&request.params),
        "connect" => connect(&request.params).await,
        "setAgentForwarding" => {
            let session = session_for(&request.params)?;
            let enabled = request
                .params
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if enabled && session.agent.sender.read().is_none() {
                return Err(TransportError::InvalidRequest(
                    "agent forwarding requires a private-key-authenticated SSH session".to_owned(),
                ));
            }
            session.agent.enabled.store(enabled, Ordering::Relaxed);
            Ok(Value::Null)
        }
        "execute" => execute(&request.params).await,
        "startShell" => start_shell(&request.params).await,
        "writeToShell" => {
            let data = required_string(&request.params, "data")?.into_bytes();
            shell_command(&request.params, ShellCommand::Write(data))
        }
        "resizeShell" => {
            let columns = request
                .params
                .get("columns")
                .and_then(Value::as_u64)
                .unwrap_or(80) as u32;
            let rows = request
                .params
                .get("rows")
                .and_then(Value::as_u64)
                .unwrap_or(24) as u32;
            shell_command(&request.params, ShellCommand::Resize { columns, rows })
        }
        "closeShell" => shell_command(&request.params, ShellCommand::Close),
        "measureHostLatency" => latency(&request.params).await,
        "getRemoteHome" => {
            let mut params = request.params.clone();
            params["command"] = json!(REMOTE_HOME_COMMAND);
            let value = execute(&params).await?;
            Ok(json!(value["stdout"].as_str().unwrap_or_default()))
        }
        "connectSFTP" => connect_sftp(&request.params).await,
        "disconnectSFTP" => {
            let key = required_string(&request.params, "key")?;
            let removed_sftp = { sftp_sessions().write().remove(&key) };
            if let Some(sftp) = removed_sftp {
                sftp.close().await?;
            }
            Ok(Value::Null)
        }
        "sftpLs" => sftp_list(&request.params).await,
        "sftpRename" => {
            let (_, sftp) = sftp_for(&request.params)?;
            sftp.rename(
                required_string(&request.params, "oldPath")?,
                required_string(&request.params, "newPath")?,
            )
            .await?;
            Ok(Value::Null)
        }
        "sftpMkdir" => sftp_mutation(&request.params, "mkdir").await,
        "sftpRm" => sftp_mutation(&request.params, "rm").await,
        "sftpRmdir" => sftp_mutation(&request.params, "rmdir").await,
        "sftpChmod" => sftp_mutation(&request.params, "chmod").await,
        "sftpUpload" => sftp_transfer(&request.params, true).await,
        "sftpDownload" => sftp_transfer(&request.params, false).await,
        "sftpCancelUpload" | "sftpCancelDownload" => {
            let key = required_string(&request.params, "key")?;
            let direction = if request.operation.ends_with("Upload") {
                "upload"
            } else {
                "download"
            };
            if let Some(cancel) = transfers().read().get(&(key, direction)) {
                cancel.store(true, Ordering::Relaxed);
            }
            Ok(Value::Null)
        }
        "openLocalForward" => open_local_forward(&request.params).await,
        "closeLocalForward" => {
            let key = required_string(&request.params, "key")?;
            let port = required_u16(&request.params, "localPort")?;
            if let Some(cancel) = forwards().write().remove(&(key, port)) {
                let _ = cancel.send(true);
            }
            Ok(Value::Null)
        }
        "requestHerdrApi" => request_streamlocal(&request.params).await,
        "startHerdrEventStream" => start_stream(&request.params, false).await,
        "writeHerdrEventStream" => stream_command(
            &request.params,
            false,
            StreamCommand::Write(required_string(&request.params, "value")?.into_bytes()),
        ),
        "closeHerdrEventStream" => stream_command(&request.params, false, StreamCommand::Close),
        "startHerdrCommandStream" => start_stream(&request.params, true).await,
        "writeHerdrCommandStream" => stream_command(
            &request.params,
            true,
            StreamCommand::Write(required_string(&request.params, "value")?.into_bytes()),
        ),
        "closeHerdrCommandStream" => stream_command(&request.params, true, StreamCommand::Close),
        "prepareHerdrBridge" => prepare_bridge(&request.params).await,
        "startHerdrBridge" => start_bridge(&request.params).await,
        "herdrBridgeInput" => bridge_command(
            &request.params,
            BridgeCommand::Send(herdr_codec::input(&required_string(
                &request.params,
                "text",
            )?)),
        ),
        "herdrBridgeResize" => bridge_command(
            &request.params,
            BridgeCommand::Send(herdr_codec::resize(
                required_u32(&request.params, "columns", Some(80))?,
                required_u32(&request.params, "rows", Some(24))?,
                required_u32(&request.params, "cellWidthPx", Some(0))?,
                required_u32(&request.params, "cellHeightPx", Some(0))?,
            )),
        ),
        "herdrBridgeScroll" => bridge_command(
            &request.params,
            BridgeCommand::Send(herdr_codec::scroll(
                request
                    .params
                    .get("up")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                required_u32(&request.params, "lines", None)?,
            )),
        ),
        "closeHerdrBridge" => {
            let key = required_string(&request.params, "key")?;
            let terminal_id = required_string(&request.params, "terminalId")?;
            if let Some(handle) = bridges().write().remove(&(key, terminal_id)) {
                let _ = handle.sender.try_send(BridgeCommand::Close);
            }
            Ok(Value::Null)
        }
        "closeAllHerdrBridges" => {
            close_all_bridges(&required_string(&request.params, "key")?);
            Ok(Value::Null)
        }
        "disconnect" => {
            let key = required_string(&request.params, "key")?;
            disconnect_key(key).await;
            Ok(Value::Null)
        }
        "debugSession" => {
            let key = required_string(&request.params, "key")?;
            let session = sessions()
                .read()
                .get(&key)
                .cloned()
                .ok_or(TransportError::UnknownClient)?;
            Ok(json!({ "host": session.host, "port": session.port }))
        }
        operation => Err(TransportError::InvalidRequest(format!(
            "unsupported operation '{operation}'"
        ))),
    }
}

fn serialize_response(response: &Response) -> String {
    serde_json::to_string(response).unwrap_or_else(|error| {
        format!(r#"{{"ok":false,"error":"response serialization failed: {error}"}}"#)
    })
}

async fn dispatch_json(input: &str) -> String {
    let response = match serde_json::from_str::<Request>(input) {
        Ok(request) => match dispatch(request).await {
            Ok(value) => Response::success(value),
            Err(error) => Response::failure(error),
        },
        Err(error) => Response::failure(format!("invalid request JSON: {error}")),
    };
    serialize_response(&response)
}

async fn process_json_async(input: &str) -> String {
    match AssertUnwindSafe(dispatch_json(input)).catch_unwind().await {
        Ok(response) => response,
        Err(_) => serialize_response(&Response::failure("Rust SSH operation panicked")),
    }
}

fn process_json(input: &str) -> String {
    match runtime() {
        Ok(runtime) => runtime.block_on(process_json_async(input)),
        Err(error) => serialize_response(&Response::failure(format!(
            "failed to initialize SSH runtime: {error}"
        ))),
    }
}

async fn process_json_for_lifecycle(input: Option<String>, lifecycle_epoch: u64) -> String {
    let request_key = input.as_deref().and_then(|input| {
        serde_json::from_str::<Request>(input)
            .ok()
            .and_then(|request| request.params.get("key")?.as_str().map(str::to_owned))
    });
    let mut response = match input {
        Some(input) => process_json_async(&input).await,
        None => r#"{"ok":false,"error":"request pointer was null"}"#.to_owned(),
    };
    if LIFECYCLE_EPOCH.load(Ordering::Acquire) != lifecycle_epoch {
        if let Some(key) = request_key {
            disconnect_key(key).await;
        }
        response = r#"{"ok":false,"error":"Rust SSH bridge was invalidated"}"#.to_owned();
    }
    response
}

#[uniffi::export]
pub fn call(request_json: String) -> String {
    process_json(&request_json)
}

#[uniffi::export]
pub async fn call_async(request_json: String) -> String {
    let lifecycle_epoch = LIFECYCLE_EPOCH.load(Ordering::Acquire);
    let task = match runtime() {
        Ok(runtime) => runtime.spawn(process_json_for_lifecycle(
            Some(request_json),
            lifecycle_epoch,
        )),
        Err(error) => {
            return serialize_response(&Response::failure(format!(
                "failed to initialize SSH runtime: {error}"
            )));
        }
    };
    match task.await {
        Ok(response) => response,
        Err(error) => serialize_response(&Response::failure(format!(
            "SSH runtime task failed: {error}"
        ))),
    }
}

fn fast_path_result(result: Result<(), TransportError>) -> Option<String> {
    result.err().map(|error| error.to_string())
}

#[uniffi::export]
pub fn write_shell_input(key: String, data: String) -> Option<String> {
    fast_path_result(shell_command_for_key(
        &key,
        ShellCommand::Write(data.into_bytes()),
    ))
}

#[uniffi::export]
pub fn resize_shell_fast(key: String, columns: u32, rows: u32) -> Option<String> {
    fast_path_result(shell_command_for_key(
        &key,
        ShellCommand::Resize { columns, rows },
    ))
}

#[uniffi::export]
pub fn herdr_bridge_input_fast(key: String, terminal_id: String, text: String) -> Option<String> {
    fast_path_result(bridge_command_for_key(
        &key,
        &terminal_id,
        BridgeCommand::Send(herdr_codec::input(&text)),
    ))
}

#[uniffi::export]
pub fn herdr_bridge_resize_fast(
    key: String,
    terminal_id: String,
    columns: u32,
    rows: u32,
    cell_width_px: u32,
    cell_height_px: u32,
) -> Option<String> {
    fast_path_result(bridge_command_for_key(
        &key,
        &terminal_id,
        BridgeCommand::Send(herdr_codec::resize(
            columns,
            rows,
            cell_width_px,
            cell_height_px,
        )),
    ))
}

#[uniffi::export]
pub fn herdr_bridge_scroll_fast(
    key: String,
    terminal_id: String,
    up: bool,
    lines: u32,
) -> Option<String> {
    fast_path_result(bridge_command_for_key(
        &key,
        &terminal_id,
        BridgeCommand::Send(herdr_codec::scroll(up, lines)),
    ))
}

#[uniffi::export]
pub fn set_event_sink(sink: Arc<dyn WhipSshEventSink>) {
    *uniffi_event_sink().write() = Some(sink);
}

#[uniffi::export]
pub fn clear_event_sink() {
    *uniffi_event_sink().write() = None;
}

/// Executes one transport operation. The caller owns the returned UTF-8 string
/// and must release it with [`whip_ssh_string_free`].
///
/// # Safety
///
/// `request_json` must be null or point to a valid NUL-terminated byte string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_ssh_call(request_json: *const c_char) -> *mut c_char {
    if request_json.is_null() {
        return CString::new(r#"{"ok":false,"error":"request pointer was null"}"#)
            .map_or(std::ptr::null_mut(), CString::into_raw);
    }
    let input = unsafe { CStr::from_ptr(request_json) }.to_string_lossy();
    CString::new(process_json(&input)).map_or(std::ptr::null_mut(), CString::into_raw)
}

/// Schedules an operation on the transport runtime. The response pointer is
/// valid only for the duration of the callback and must be copied by the caller.
///
/// # Safety
///
/// `request_json` must be null or point to a valid NUL-terminated byte string.
/// The callback must remain callable until it receives this request's response.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_ssh_call_async(
    request_id: u64,
    request_json: *const c_char,
    callback: Option<ResponseCallback>,
) {
    let Some(callback) = callback else { return };
    let input = if request_json.is_null() {
        None
    } else {
        Some(
            unsafe { CStr::from_ptr(request_json) }
                .to_string_lossy()
                .into_owned(),
        )
    };
    let lifecycle_epoch = LIFECYCLE_EPOCH.load(Ordering::Acquire);
    let runtime = match runtime() {
        Ok(runtime) => runtime,
        Err(error) => {
            let response = serialize_response(&Response::failure(format!(
                "failed to initialize SSH runtime: {error}"
            )));
            if let Ok(response) = CString::new(response) {
                unsafe { callback(request_id, response.as_ptr()) };
            }
            return;
        }
    };
    runtime.spawn(async move {
        let response = process_json_for_lifecycle(input, lifecycle_epoch).await;
        if let Ok(response) = CString::new(response) {
            // The Objective-C callback copies the string before returning.
            unsafe { callback(request_id, response.as_ptr()) };
        }
    });
}

/// Releases a string previously returned by [`whip_ssh_call`].
///
/// # Safety
///
/// `value` must be null or a pointer returned by [`whip_ssh_call`] that has not
/// already been released.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_ssh_string_free(value: *mut c_char) {
    if !value.is_null() {
        drop(unsafe { CString::from_raw(value) });
    }
}

/// Registers the process-wide event sink. Passing `None` detaches it.
#[unsafe(no_mangle)]
pub extern "C" fn whip_ssh_set_event_callback(callback: Option<EventCallback>) {
    *event_callback().write() = callback;
}

fn shutdown_transport() {
    *uniffi_event_sink().write() = None;
    LIFECYCLE_EPOCH.fetch_add(1, Ordering::AcqRel);
    if let Ok(runtime) = runtime() {
        runtime.spawn(shutdown_all());
    }
}

#[uniffi::export]
pub fn shutdown() {
    shutdown_transport();
}

/// Stops all process-wide sessions and child tasks during React Native bridge
/// invalidation. Cleanup is asynchronous so invalidation never blocks JS.
#[unsafe(no_mangle)]
pub extern "C" fn whip_ssh_shutdown() {
    shutdown_transport();
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn live_call(operation: &str, params: Value) -> Value {
        dispatch(Request {
            operation: operation.to_owned(),
            params,
        })
        .await
        .unwrap_or_else(|error| panic!("{operation} failed: {error}"))
    }

    #[test]
    fn invalid_json_is_a_structured_failure() {
        let result: Value = serde_json::from_str(&process_json("{")).unwrap();
        assert_eq!(result["ok"], false);
        assert!(
            result["error"]
                .as_str()
                .unwrap()
                .contains("invalid request JSON")
        );
    }

    #[test]
    fn missing_parameter_is_a_structured_failure() {
        let result: Value =
            serde_json::from_str(&process_json(r#"{"operation":"connect"}"#)).unwrap();
        assert_eq!(result["ok"], false);
        assert!(
            result["error"]
                .as_str()
                .unwrap()
                .contains("missing string parameter 'key'")
        );
    }

    #[test]
    fn remote_home_command_expands_without_literal_quotes() {
        assert_eq!(REMOTE_HOME_COMMAND, "printf %s \"$HOME\"");
    }

    #[test]
    fn typed_terminal_fast_paths_report_missing_sessions_without_json() {
        assert_eq!(
            write_shell_input("missing-shell".to_owned(), "x".to_owned()).as_deref(),
            Some("unknown client")
        );
        assert!(
            herdr_bridge_input_fast(
                "missing-client".to_owned(),
                "missing-terminal".to_owned(),
                "x".to_owned(),
            )
            .is_some_and(|error| error.contains("Herdr bridge is not active"))
        );
    }

    #[test]
    fn answers_standard_keyboard_interactive_password_prompts() {
        let prompts = [client::Prompt {
            prompt: "Password:".to_owned(),
            echo: false,
        }];
        assert_eq!(
            keyboard_interactive_password_responses(&prompts, "a1", "secret"),
            Some(vec!["secret".to_owned()]),
        );
    }

    #[test]
    fn refuses_unknown_keyboard_interactive_challenges() {
        let prompts = [
            client::Prompt {
                prompt: "Password:".to_owned(),
                echo: false,
            },
            client::Prompt {
                prompt: "Verification code:".to_owned(),
                echo: false,
            },
        ];
        assert_eq!(
            keyboard_interactive_password_responses(&prompts, "a1", "secret"),
            None,
        );
    }

    #[test]
    fn generated_ed25519_key_round_trips_through_inspection() {
        let generated = generate_key_pair(&json!({
            "type": "ed25519",
            "passphrase": "test-passphrase",
            "comment": "whip-test",
        }))
        .unwrap();
        let details = key_details(&json!({
            "privateKey": generated["privateKey"],
            "passphrase": "test-passphrase",
        }))
        .unwrap();
        assert_eq!(details["keyType"], "ssh-ed25519");
        assert_eq!(details["keySize"], 256);
        assert_eq!(details["publicKey"], generated["publicKey"]);
        assert!(
            details["fingerprint"]
                .as_str()
                .unwrap()
                .starts_with("SHA256:")
        );
    }

    #[test]
    fn forwarded_agent_lists_and_signs_with_the_authenticated_key() {
        let mut rng =
            russh::keys::ssh_key::rand_core::UnwrapErr(russh::keys::ssh_key::getrandom::SysRng);
        let private_key = Arc::new(
            russh::keys::PrivateKey::random(&mut rng, russh::keys::Algorithm::Ed25519).unwrap(),
        );
        let state = Arc::new(AgentState::default());

        runtime().unwrap().block_on(async {
            initialize_agent(private_key, state.clone()).await.unwrap();
            let (client_stream, server_stream) = tokio::io::duplex(256 * 1024);
            state
                .sender
                .read()
                .as_ref()
                .unwrap()
                .unbounded_send(Ok(Box::new(server_stream)))
                .unwrap();
            let mut client = russh::keys::agent::client::AgentClient::connect(client_stream);
            let identities = client.request_identities().await.unwrap();
            assert_eq!(identities.len(), 1);
            let payload = b"agent-forwarding-test".to_vec();
            let signed = client
                .sign_request(&identities[0], None, payload.clone())
                .await
                .unwrap();
            assert!(signed.starts_with(&payload));
            assert!(signed.len() > payload.len());
        });
    }

    #[test]
    #[ignore = "run through tests/live-ssh.sh"]
    fn live_openssh_feature_matrix() {
        let host = std::env::var("WHIP_SSH_TEST_HOST").expect("missing test host");
        let port = std::env::var("WHIP_SSH_TEST_PORT")
            .expect("missing test port")
            .parse::<u16>()
            .expect("invalid test port");
        let target_port = std::env::var("WHIP_SSH_TEST_TARGET_PORT")
            .expect("missing target port")
            .parse::<u16>()
            .expect("invalid target port");
        let username = std::env::var("WHIP_SSH_TEST_USER").expect("missing test user");
        let private_key = std::fs::read_to_string(
            std::env::var("WHIP_SSH_TEST_PRIVATE_KEY").expect("missing private key path"),
        )
        .expect("could not read private key");
        let known_hosts = std::fs::read_to_string(
            std::env::var("WHIP_SSH_TEST_KNOWN_HOSTS").expect("missing known_hosts path"),
        )
        .expect("could not read known_hosts");
        let shared = std::path::PathBuf::from(
            std::env::var("WHIP_SSH_TEST_SHARED_DIR").expect("missing shared directory"),
        );

        runtime().unwrap().block_on(async {
            live_call("setKnownHosts", json!({"contents": known_hosts})).await;
            let credential = json!({
                "type": "key",
                "privateKey": private_key,
                "passphrase": null,
            });
            live_call(
                "connect",
                json!({
                    "host": host,
                    "port": port,
                    "username": username,
                    "credential": credential,
                    "key": "live-main",
                }),
            )
            .await;
            let executed = live_call(
                "execute",
                json!({"key": "live-main", "command": "printf whip-live"}),
            )
            .await;
            assert_eq!(executed["stdout"], "whip-live");

            live_call(
                "setAgentForwarding",
                json!({"key": "live-main", "enabled": true}),
            )
            .await;
            let agent = live_call(
                "execute",
                json!({"key": "live-main", "command": "ssh-add -L"}),
            )
            .await;
            assert!(agent["stdout"].as_str().unwrap_or_default().contains("ssh-ed25519"));

            live_call("connectSFTP", json!({"key": "live-main"})).await;
            live_call(
                "sftpMkdir",
                json!({"key": "live-main", "path": "/workspace/remote"}),
            )
            .await;
            let client_dir = shared.join("client");
            let download_dir = shared.join("download");
            fs::create_dir_all(&client_dir).await.unwrap();
            fs::create_dir_all(&download_dir).await.unwrap();
            let payload = client_dir.join("payload.txt");
            fs::write(&payload, b"sftp-live-payload").await.unwrap();
            live_call(
                "sftpUpload",
                json!({
                    "key": "live-main",
                    "localPath": payload,
                    "remotePath": "/workspace/remote",
                }),
            )
            .await;
            fs::write(&payload, b"sftp-live-replacement").await.unwrap();
            live_call(
                "sftpUpload",
                json!({
                    "key": "live-main",
                    "localPath": payload,
                    "remotePath": "/workspace/remote",
                }),
            )
            .await;
            live_call(
                "sftpChmod",
                json!({"key": "live-main", "path": "/workspace/remote/payload.txt", "permissions": 0o640}),
            )
            .await;
            live_call(
                "sftpRename",
                json!({
                    "key": "live-main",
                    "oldPath": "/workspace/remote/payload.txt",
                    "newPath": "/workspace/remote/renamed.txt",
                }),
            )
            .await;
            let entries = live_call(
                "sftpLs",
                json!({"key": "live-main", "path": "/workspace/remote"}),
            )
            .await;
            assert!(entries.as_array().unwrap().iter().any(|entry| {
                entry["filename"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("renamed.txt")
            }));
            let downloaded = live_call(
                "sftpDownload",
                json!({
                    "key": "live-main",
                    "remotePath": "/workspace/remote/renamed.txt",
                    "localPath": download_dir,
                }),
            )
            .await;
            assert_eq!(
                fs::read(downloaded.as_str().unwrap()).await.unwrap(),
                b"sftp-live-replacement"
            );

            let cancel_payload = client_dir.join("cancel.bin");
            fs::write(&cancel_payload, vec![7u8; 16 * 1024 * 1024])
                .await
                .unwrap();
            let transfer = runtime().unwrap().spawn(dispatch(Request {
                operation: "sftpUpload".to_owned(),
                params: json!({
                    "key": "live-main",
                    "localPath": cancel_payload,
                    "remotePath": "/workspace/remote",
                }),
            }));
            while !transfers()
                .read()
                .contains_key(&("live-main".to_owned(), "upload"))
            {
                tokio::task::yield_now().await;
            }
            live_call("sftpCancelUpload", json!({"key": "live-main"})).await;
            let transfer_error = transfer.await.unwrap().unwrap_err().to_string();
            assert!(transfer_error.contains("cancelled"));
            let entries = live_call(
                "sftpLs",
                json!({"key": "live-main", "path": "/workspace/remote"}),
            )
            .await;
            assert!(!entries.as_array().unwrap().iter().any(|entry| {
                entry["filename"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("whip-part")
            }));

            let forward_port = live_call(
                "openLocalForward",
                json!({
                    "key": "live-main",
                    "remoteHost": "127.0.0.1",
                    "remotePort": target_port,
                }),
            )
            .await
            .as_u64()
            .unwrap() as u16;
            let mut forwarded = tokio::net::TcpStream::connect(("127.0.0.1", forward_port))
                .await
                .unwrap();
            let mut banner = [0u8; 4];
            tokio::time::timeout(Duration::from_secs(5), forwarded.read_exact(&mut banner))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(&banner, b"SSH-");
            live_call(
                "closeLocalForward",
                json!({"key": "live-main", "localPort": forward_port}),
            )
            .await;

            live_call(
                "connect",
                json!({
                    "host": "127.0.0.1",
                    "port": target_port,
                    "username": username,
                    "credential": credential,
                    "jumpKey": "live-main",
                    "key": "live-jump-target",
                }),
            )
            .await;
            let jumped = live_call(
                "execute",
                json!({"key": "live-jump-target", "command": "printf jumped"}),
            )
            .await;
            assert_eq!(jumped["stdout"], "jumped");

            live_call(
                "connect",
                json!({
                    "host": host,
                    "port": port,
                    "username": username,
                    "credential": {"type": "password", "password": "whip-test-password"},
                    "key": "live-password",
                }),
            )
            .await;
            live_call("disconnect", json!({"key": "live-password"})).await;
            live_call("disconnect", json!({"key": "live-jump-target"})).await;
            live_call("disconnect", json!({"key": "live-main"})).await;
        });
    }
}
