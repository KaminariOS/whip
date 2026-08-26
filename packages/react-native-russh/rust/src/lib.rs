//! Product-neutral SSH transport for React Native.
//!
//! The public boundary keeps a small JSON API for control-plane operations and
//! uses typed UniFFI calls for latency-sensitive terminal traffic. The original
//! C ABI remains available for compatibility with transitional native clients.
//! React Native owns JavaScript callbacks and lifecycle, while this crate owns
//! the Tokio runtime, SSH sessions, host-key verification, and byte streams.

mod known_hosts;
uniffi::setup_scaffolding!();

use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char};
use std::future::Future;
use std::io::SeekFrom;
use std::panic::AssertUnwindSafe;
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::{Duration, Instant};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use futures::{FutureExt, channel::mpsc as futures_mpsc, future::try_join_all};
use parking_lot::RwLock;
use russh::client;
use russh::keys::{PrivateKeyWithHashAlg, PublicKey};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::runtime::Runtime;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, watch};
use tokio::{
    fs,
    io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader},
};

use crate::known_hosts::{HostKeyDecision, KnownHosts};

type Sessions = RwLock<HashMap<String, Arc<Session>>>;
type EventCallback = unsafe extern "C" fn(*const c_char);
type ResponseCallback = unsafe extern "C" fn(u64, *const c_char);
type NativeChannelOpenCallback = unsafe extern "C" fn(u64, *const c_char);
type NativeChannelFrameCallback = unsafe extern "C" fn(u64, *const u8, usize);
type NativeChannelClosedCallback = unsafe extern "C" fn(u64, *const c_char);
type NativeUnixSocketRequestCallback = unsafe extern "C" fn(u64, *const u8, usize, *const c_char);
type Shells = RwLock<HashMap<String, mpsc::Sender<ShellCommand>>>;
type SftpSessions = RwLock<HashMap<String, Arc<SftpSession>>>;
type ExecChannels = RwLock<HashMap<(String, String), mpsc::Sender<StreamCommand>>>;
type UnixSocketChannels = RwLock<HashMap<(String, String), UnixSocketChannelHandle>>;

const TERMINAL_INBOUND_RUST_FRAME_DELIVERY: &CStr = c"Whip terminal inbound Rust frame delivery";
const TERMINAL_INBOUND_RUST_FRAME_RECEIVED: &CStr = c"Whip terminal inbound Rust frame received";
const EXEC_INBOUND_RUST_CHUNK_DELIVERY: &CStr = c"Whip exec inbound Rust chunk delivery";
const EXEC_INBOUND_RUST_CHUNK_RECEIVED: &CStr = c"Whip exec inbound Rust chunk received";

#[cfg(target_os = "android")]
struct AndroidTraceSlice(bool);

#[cfg(target_os = "android")]
impl AndroidTraceSlice {
    fn begin(name: &CStr) -> Self {
        // Checking first avoids CString work and kernel trace writes when the
        // app is not part of an active Perfetto/atrace capture.
        let enabled = unsafe { ATrace_isEnabled() };
        if enabled {
            unsafe { ATrace_beginSection(name.as_ptr()) };
        }
        Self(enabled)
    }
}

#[cfg(target_os = "android")]
impl Drop for AndroidTraceSlice {
    fn drop(&mut self) {
        if self.0 {
            unsafe { ATrace_endSection() };
        }
    }
}

#[cfg(target_os = "android")]
#[link(name = "android")]
unsafe extern "C" {
    fn ATrace_isEnabled() -> bool;
    fn ATrace_beginSection(section_name: *const c_char);
    fn ATrace_endSection();
}

#[cfg(not(target_os = "android"))]
struct AndroidTraceSlice;

#[cfg(not(target_os = "android"))]
impl AndroidTraceSlice {
    fn begin(_name: &CStr) -> Self {
        Self
    }
}
type Forwards = RwLock<HashMap<(String, u16), watch::Sender<bool>>>;
type SftpFileServers = RwLock<HashMap<(String, u16), watch::Sender<bool>>>;
type Transfers = RwLock<HashMap<(String, &'static str), watch::Sender<bool>>>;

static RUNTIME: OnceLock<Result<Runtime, String>> = OnceLock::new();
static SESSIONS: OnceLock<Sessions> = OnceLock::new();
static KNOWN_HOSTS: OnceLock<RwLock<KnownHosts>> = OnceLock::new();
static EVENT_CALLBACK: OnceLock<RwLock<Option<EventCallback>>> = OnceLock::new();
static UNIFFI_EVENT_SINK: OnceLock<RwLock<Option<Arc<dyn ReactNativeRusshEventSink>>>> =
    OnceLock::new();
static SHELLS: OnceLock<Shells> = OnceLock::new();
static SFTP_SESSIONS: OnceLock<SftpSessions> = OnceLock::new();
static EXEC_CHANNELS: OnceLock<ExecChannels> = OnceLock::new();
static UNIX_SOCKET_CHANNELS: OnceLock<UnixSocketChannels> = OnceLock::new();
static FORWARDS: OnceLock<Forwards> = OnceLock::new();
static SFTP_FILE_SERVERS: OnceLock<SftpFileServers> = OnceLock::new();
static TRANSFERS: OnceLock<Transfers> = OnceLock::new();
static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);
static LIFECYCLE_EPOCH: AtomicU64 = AtomicU64::new(1);

const CONTROL_QUEUE_CAPACITY: usize = 256;
const INBOUND_DELIVERY_QUEUE_CAPACITY: usize = 64;
const INBOUND_DELIVERY_BYTE_CAPACITY: usize = 8 * 1024 * 1024;
const HOST_LATENCY_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const EXECUTE_OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const SFTP_HTTP_HEADER_LIMIT: usize = 16 * 1024;
const SFTP_HTTP_PIPELINE_DEPTH: usize = 8;
const SFTP_HTTP_READ_SIZE: u64 = 256 * 1024;
const SFTP_HTTP_SERVER_LIFETIME: Duration = Duration::from_secs(60 * 60);
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
    ChannelUnavailable(String),
    #[error("{0}")]
    HostUnreachable(String),
    #[error("unknown SSH host key")]
    HostKeyUnknown(known_hosts::HostKeyChallenge),
    #[error("SSH host key changed")]
    HostKeyChanged(known_hosts::HostKeyChallenge),
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum SshErrorCode {
    AuthenticationFailed,
    HostKeyUnknown,
    HostKeyChanged,
    ConnectionRefused,
    ConnectionTimeout,
    HostUnreachable,
    ChannelUnavailable,
    SessionClosed,
    InvalidPrivateKey,
    SftpFailure,
    InvalidRequest,
    Unknown,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshError {
    code: SshErrorCode,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

impl SshError {
    fn new(code: SshErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }

    fn unknown(message: impl Into<String>) -> Self {
        Self::new(SshErrorCode::Unknown, message)
    }
}

impl From<TransportError> for SshError {
    fn from(error: TransportError) -> Self {
        let code = transport_error_code(&error);
        let details = match &error {
            TransportError::HostKeyUnknown(challenge)
            | TransportError::HostKeyChanged(challenge) => Some(json!(challenge)),
            _ => None,
        };
        Self {
            code,
            message: error.to_string(),
            details,
        }
    }
}

fn transport_error_code(error: &TransportError) -> SshErrorCode {
    match error {
        TransportError::InvalidRequest(_) => SshErrorCode::InvalidRequest,
        TransportError::UnknownClient => SshErrorCode::SessionClosed,
        TransportError::AuthenticationFailed => SshErrorCode::AuthenticationFailed,
        TransportError::ChannelUnavailable(_) => SshErrorCode::ChannelUnavailable,
        TransportError::HostUnreachable(_) => SshErrorCode::HostUnreachable,
        TransportError::HostKeyUnknown(_) => SshErrorCode::HostKeyUnknown,
        TransportError::HostKeyChanged(_) => SshErrorCode::HostKeyChanged,
        TransportError::Ssh(error) => match error {
            russh::Error::WrongChannel | russh::Error::ChannelOpenFailure(_) => {
                SshErrorCode::ChannelUnavailable
            }
            russh::Error::Disconnect
            | russh::Error::HUP
            | russh::Error::SendError
            | russh::Error::RecvError => SshErrorCode::SessionClosed,
            russh::Error::ConnectionTimeout
            | russh::Error::KeepaliveTimeout
            | russh::Error::InactivityTimeout
            | russh::Error::Elapsed(_) => SshErrorCode::ConnectionTimeout,
            russh::Error::IO(error) => io_error_code(error),
            _ => SshErrorCode::Unknown,
        },
        TransportError::Key(_) | TransportError::SshKey(_) => SshErrorCode::InvalidPrivateKey,
        TransportError::Io(error) => io_error_code(error),
        TransportError::Sftp(_) => SshErrorCode::SftpFailure,
    }
}

fn io_error_code(error: &std::io::Error) -> SshErrorCode {
    match error.kind() {
        std::io::ErrorKind::ConnectionRefused => SshErrorCode::ConnectionRefused,
        std::io::ErrorKind::TimedOut => SshErrorCode::ConnectionTimeout,
        std::io::ErrorKind::NotConnected
        | std::io::ErrorKind::ConnectionReset
        | std::io::ErrorKind::ConnectionAborted
        | std::io::ErrorKind::BrokenPipe
        | std::io::ErrorKind::UnexpectedEof
        | std::io::ErrorKind::AddrNotAvailable
        | std::io::ErrorKind::NetworkUnreachable
        | std::io::ErrorKind::HostUnreachable => SshErrorCode::HostUnreachable,
        _ => SshErrorCode::Unknown,
    }
}

fn classify_direct_connect_error(error: TransportError) -> TransportError {
    match error {
        TransportError::Ssh(russh::Error::IO(source))
            if io_error_code(&source) == SshErrorCode::Unknown =>
        {
            TransportError::HostUnreachable(source.to_string())
        }
        error => error,
    }
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
    error: Option<SshError>,
}

impl Response {
    fn success(value: Value) -> Self {
        Self {
            ok: true,
            value: Some(value),
            error: None,
        }
    }

    fn failure(error: impl Into<SshError>) -> Self {
        Self {
            ok: false,
            value: None,
            error: Some(error.into()),
        }
    }
}

#[uniffi::export(with_foreign)]
pub trait ReactNativeRusshEventSink: Send + Sync {
    fn emit(&self, event_json: String);
    fn unix_socket_channel_data(&self, key: String, channel_id: String, bytes: Vec<u8>);
    fn exec_channel_data(&self, key: String, channel_id: String, bytes: Vec<u8>);
}

struct Session {
    handle: client::Handle<RusshHandler>,
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
struct RestrictedAgent {
    allow_initial_add: Arc<AtomicBool>,
}

impl russh::keys::agent::server::Agent for RestrictedAgent {
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

#[derive(Clone)]
struct UnixSocketChannelHandle {
    sender: mpsc::Sender<StreamCommand>,
    framing: Option<LengthFormat>,
}

struct OwnedInboundFrame {
    bytes: Vec<u8>,
    _byte_permit: OwnedSemaphorePermit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LengthFormat {
    U8,
    U16Le,
    U16Be,
    U32Le,
    U32Be,
}

/// Product-neutral delivery target for an owned Unix-socket channel.
///
/// Native callbacks let another native library compose with the connected SSH
/// transport without routing binary frames through JavaScript. Callback byte
/// and string pointers are borrowed only for the duration of the call.
#[derive(Clone, Copy)]
enum UnixSocketDelivery {
    ReactNative,
    Native {
        context: u64,
        frame: NativeChannelFrameCallback,
        closed: NativeChannelClosedCallback,
    },
}

#[derive(Clone)]
struct RusshHandler {
    host: String,
    port: u16,
    agent: Arc<AgentState>,
}

impl client::Handler for RusshHandler {
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
            HostKeyDecision::Unknown(challenge) => Err(TransportError::HostKeyUnknown(challenge)),
            HostKeyDecision::Changed(challenge) => Err(TransportError::HostKeyChanged(challenge)),
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
fn uniffi_event_sink() -> &'static RwLock<Option<Arc<dyn ReactNativeRusshEventSink>>> {
    UNIFFI_EVENT_SINK.get_or_init(|| RwLock::new(None))
}
fn sftp_sessions() -> &'static SftpSessions {
    SFTP_SESSIONS.get_or_init(|| RwLock::new(HashMap::new()))
}
fn exec_channels() -> &'static ExecChannels {
    EXEC_CHANNELS.get_or_init(|| RwLock::new(HashMap::new()))
}
fn unix_socket_channels() -> &'static UnixSocketChannels {
    UNIX_SOCKET_CHANNELS.get_or_init(|| RwLock::new(HashMap::new()))
}
fn forwards() -> &'static Forwards {
    FORWARDS.get_or_init(|| RwLock::new(HashMap::new()))
}
fn sftp_file_servers() -> &'static SftpFileServers {
    SFTP_FILE_SERVERS.get_or_init(|| RwLock::new(HashMap::new()))
}
fn transfers() -> &'static Transfers {
    TRANSFERS.get_or_init(|| RwLock::new(HashMap::new()))
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
        .unwrap_or("react-native-russh");
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
    let agent_policy = RestrictedAgent {
        allow_initial_add: Arc::new(AtomicBool::new(true)),
    };
    tokio::spawn(async move {
        let _ = russh::keys::agent::server::serve(receiver, agent_policy).await;
    });

    // Seed the private key into the in-process agent over the same protocol
    // used by forwarded clients. The remote side can list and sign with it,
    // but RestrictedAgent rejects add/remove/lock requests.
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
    let handler = RusshHandler {
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
        client::connect(config, (host.as_str(), port), handler)
            .await
            .map_err(classify_direct_connect_error)?
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
    handle: &mut client::Handle<RusshHandler>,
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
        stdout.extend_from_slice(b"\n[react-native-russh: stdout truncated at 8 MiB]\n");
    }
    if stderr_truncated {
        stderr.extend_from_slice(b"\n[react-native-russh: stderr truncated at 8 MiB]\n");
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
    tokio::time::timeout(HOST_LATENCY_PROBE_TIMEOUT, session.handle.send_ping())
        .await
        .map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::TimedOut, "SSH latency probe timed out")
        })??;
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
        TransportError::ChannelUnavailable(format!("shell control queue rejected input: {error}"))
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

async fn sftp_create_dir_all(params: &Value) -> Result<Value, TransportError> {
    let (_, sftp) = sftp_for(params)?;
    let remote_path = required_string(params, "path")?;
    if remote_path.is_empty() {
        return Err(TransportError::InvalidRequest(
            "remote directory path must not be empty".to_owned(),
        ));
    }

    let mut current = if remote_path.starts_with('/') {
        "/".to_owned()
    } else {
        String::new()
    };
    for component in remote_path
        .split('/')
        .filter(|component| !component.is_empty())
    {
        if component == "." {
            continue;
        }
        if !current.is_empty() && current != "/" {
            current.push('/');
        }
        current.push_str(component);

        match sftp.metadata(current.clone()).await {
            Ok(metadata) if metadata.is_dir() => continue,
            Ok(_) => {
                return Err(TransportError::InvalidRequest(format!(
                    "remote path component '{current}' is not a directory"
                )));
            }
            Err(_) => {}
        }

        if let Err(create_error) = sftp.create_dir(current.clone()).await {
            // Another client may have created the directory after metadata.
            // Treat that race as success, but do not hide file collisions or
            // the original server error.
            match sftp.metadata(current.clone()).await {
                Ok(metadata) if metadata.is_dir() => {}
                Ok(_) => {
                    return Err(TransportError::InvalidRequest(format!(
                        "remote path component '{current}' is not a directory"
                    )));
                }
                Err(_) => return Err(create_error.into()),
            }
        }
    }

    if current.is_empty() {
        return Err(TransportError::InvalidRequest(
            "remote directory path must contain a directory".to_owned(),
        ));
    }
    Ok(Value::Null)
}

fn transfer_cancelled(direction: &str) -> TransportError {
    TransportError::InvalidRequest(format!("SFTP {direction} cancelled"))
}

async fn wait_for_transfer_cancel(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow_and_update() {
            return;
        }
        if cancel.changed().await.is_err() {
            return;
        }
    }
}

async fn cancellable_transfer_io<T, E, F>(
    cancel: &mut watch::Receiver<bool>,
    direction: &str,
    future: F,
) -> Result<T, TransportError>
where
    F: Future<Output = Result<T, E>>,
    TransportError: From<E>,
{
    tokio::select! {
        biased;
        _ = wait_for_transfer_cancel(cancel) => Err(transfer_cancelled(direction)),
        result = future => result.map_err(TransportError::from),
    }
}

async fn copy_sftp_stream(
    mut source: Box<dyn tokio::io::AsyncRead + Unpin + Send>,
    mut destination: Box<dyn tokio::io::AsyncWrite + Unpin + Send>,
    total: u64,
    key: &str,
    direction: &str,
    event: &str,
    cancel: &mut watch::Receiver<bool>,
) -> Result<(), TransportError> {
    let mut copied = 0u64;
    let mut last_percent = None;
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let count = cancellable_transfer_io(cancel, direction, source.read(&mut buffer)).await?;
        if count == 0 {
            break;
        }
        cancellable_transfer_io(cancel, direction, destination.write_all(&buffer[..count])).await?;
        copied += count as u64;
        let percent = copied.saturating_mul(100).checked_div(total).unwrap_or(100);
        if last_percent != Some(percent) {
            emit_event(json!({ "name": event, "key": key, "value": percent.to_string() }));
            last_percent = Some(percent);
        }
    }
    cancellable_transfer_io(cancel, direction, destination.shutdown()).await?;
    if last_percent != Some(100) {
        emit_event(json!({ "name": event, "key": key, "value": "100" }));
    }
    Ok(())
}

async fn sftp_transfer(
    params: &Value,
    upload: bool,
    upload_to_exact_path: bool,
) -> Result<Value, TransportError> {
    let (key, sftp) = sftp_for(params)?;
    let local = required_string(params, "localPath")?;
    let remote_path = required_string(params, "remotePath")?;
    let direction = if upload { "upload" } else { "download" };
    let event = if upload {
        "UploadProgress"
    } else {
        "DownloadProgress"
    };
    let (cancel_sender, mut cancel) = watch::channel(false);
    {
        let mut active = transfers().write();
        if active.contains_key(&(key.clone(), direction)) {
            return Err(TransportError::InvalidRequest(format!(
                "an SFTP {direction} is already active for this connection"
            )));
        }
        active.insert((key.clone(), direction), cancel_sender);
    }
    let result: Result<String, TransportError> = async {
        if upload {
            let source = fs::File::open(&local).await?;
            let total = source.metadata().await?.len();
            let destination_path = if upload_to_exact_path {
                if remote_path.is_empty() || remote_path.ends_with('/') {
                    return Err(TransportError::InvalidRequest(
                        "exact remote upload path must end with a filename".to_owned(),
                    ));
                }
                remote_path.clone()
            } else {
                let filename = std::path::Path::new(&local)
                    .file_name()
                    .and_then(|v| v.to_str())
                    .ok_or_else(|| {
                        TransportError::InvalidRequest("local path has no filename".to_owned())
                    })?;
                // Directory uploads preserve the local basename. Downloads and
                // exact-path uploads interpret remotePath as a file.
                format!("{}/{}", remote_path.trim_end_matches('/'), filename)
            };
            let transfer_id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
            let temp_path = format!("{destination_path}.russh-part-{transfer_id}");
            let destination = sftp.create(temp_path.clone()).await?;
            let copied = copy_sftp_stream(
                Box::new(source),
                Box::new(destination),
                total,
                &key,
                direction,
                event,
                &mut cancel,
            )
            .await;
            if let Err(error) = copied {
                let _ = sftp.remove_file(temp_path).await;
                return Err(error);
            }
            if *cancel.borrow() {
                let _ = sftp.remove_file(temp_path).await;
                return Err(transfer_cancelled(direction));
            }
            // Standard SFTP rename does not replace existing files on every
            // server. Preserve the prior file until the complete upload exists,
            // and restore it if the final rename fails.
            let backup_path = format!("{destination_path}.russh-backup-{transfer_id}");
            let had_prior_file = sftp.metadata(destination_path.clone()).await.is_ok();
            if *cancel.borrow() {
                let _ = sftp.remove_file(temp_path).await;
                return Err(transfer_cancelled(direction));
            }
            if had_prior_file {
                sftp.rename(destination_path.clone(), backup_path.clone())
                    .await?;
                if *cancel.borrow() {
                    let _ = sftp.rename(backup_path, destination_path).await;
                    let _ = sftp.remove_file(temp_path).await;
                    return Err(transfer_cancelled(direction));
                }
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
            if *cancel.borrow() {
                let _ = sftp.remove_file(destination_path.clone()).await;
                if had_prior_file {
                    let _ = sftp.rename(backup_path, destination_path).await;
                }
                return Err(transfer_cancelled(direction));
            }
            if had_prior_file {
                let _ = sftp.remove_file(backup_path).await;
            }
            Ok(String::new())
        } else {
            let source = sftp.open(&remote_path).await?;
            let total = source.metadata().await?.size.unwrap_or_default();
            let filename = std::path::Path::new(&remote_path)
                .file_name()
                .and_then(|v| v.to_str())
                .ok_or_else(|| {
                    TransportError::InvalidRequest("remote path has no filename".to_owned())
                })?;
            let destination_path = format!("{}/{}", local.trim_end_matches('/'), filename);
            let temp_path = format!(
                "{destination_path}.russh-part-{}",
                NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed)
            );
            let destination = fs::File::create(&temp_path).await?;
            let copied = copy_sftp_stream(
                Box::new(source),
                Box::new(destination),
                total,
                &key,
                direction,
                event,
                &mut cancel,
            )
            .await;
            if let Err(error) = copied {
                let _ = fs::remove_file(temp_path).await;
                return Err(error);
            }
            if *cancel.borrow() {
                let _ = fs::remove_file(temp_path).await;
                return Err(transfer_cancelled(direction));
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

async fn request_unix_socket_bytes(
    params: &Value,
    request: &[u8],
) -> Result<Vec<u8>, TransportError> {
    let session = session_for(params)?;
    let socket_path = required_string(params, "socketPath")?;
    let terminator = params
        .get("responseTerminator")
        .and_then(Value::as_str)
        .unwrap_or("\n")
        .as_bytes();
    if terminator.len() != 1 {
        return Err(TransportError::InvalidRequest(
            "responseTerminator must encode to exactly one byte".to_owned(),
        ));
    }
    let timeout_ms = params
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(15_000)
        .clamp(1, 300_000);
    let max_response_bytes = params
        .get("maxResponseBytes")
        .and_then(Value::as_u64)
        .unwrap_or(8 * 1024 * 1024)
        .clamp(1, 32 * 1024 * 1024);
    let channel = session
        .handle
        .channel_open_direct_streamlocal(socket_path)
        .await?;
    let mut stream = BufReader::new(channel.into_stream());
    stream.write_all(request).await?;
    let mut reader = stream.take(max_response_bytes + 1);
    let mut response = Vec::new();
    tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        reader.read_until(terminator[0], &mut response),
    )
    .await
    .map_err(|_| {
        TransportError::InvalidRequest("timed out waiting for Unix-socket response".to_owned())
    })??;
    if response.len() as u64 > max_response_bytes {
        return Err(TransportError::InvalidRequest(format!(
            "Unix-socket response exceeds {max_response_bytes} bytes"
        )));
    }
    if response.last() != Some(&terminator[0]) {
        return Err(TransportError::InvalidRequest(
            "Unix-socket response ended before its terminator".to_owned(),
        ));
    }
    response.pop();
    Ok(response)
}

async fn request_unix_socket(params: &Value) -> Result<Value, TransportError> {
    let request = required_string(params, "request")?;
    let response = request_unix_socket_bytes(params, request.as_bytes()).await?;
    Ok(json!(String::from_utf8_lossy(&response)))
}

fn emit_unix_socket_channel_data(key: &str, channel_id: &str, bytes: Vec<u8>) {
    let sink = uniffi_event_sink().read().clone();
    let callback = *event_callback().read();
    let legacy_json = callback.map(|_| {
        serde_json::to_string(&json!({
            "name": "UnixSocketChannel",
            "key": key,
            "value": {
                "type": "data",
                "channelId": channel_id,
                "bytes": BASE64.encode(&bytes),
            },
        }))
        .unwrap_or_default()
    });
    if let Some(sink) = sink {
        sink.unix_socket_channel_data(key.to_owned(), channel_id.to_owned(), bytes);
    }
    if let (Some(callback), Some(json)) = (callback, legacy_json) {
        emit_legacy_json(callback, json);
    }
}

impl LengthFormat {
    fn parse(value: &str) -> Result<Self, TransportError> {
        match value {
            "u8" => Ok(Self::U8),
            "u16le" => Ok(Self::U16Le),
            "u16be" => Ok(Self::U16Be),
            "u32le" => Ok(Self::U32Le),
            "u32be" => Ok(Self::U32Be),
            _ => Err(TransportError::InvalidRequest(format!(
                "unsupported length format '{value}'"
            ))),
        }
    }

    fn prefix(self, length: usize) -> Result<Vec<u8>, TransportError> {
        let overflow = || {
            TransportError::InvalidRequest(format!(
                "frame length {length} cannot be represented by this length format"
            ))
        };
        match self {
            Self::U8 => Ok(vec![u8::try_from(length).map_err(|_| overflow())?]),
            Self::U16Le => Ok(u16::try_from(length)
                .map_err(|_| overflow())?
                .to_le_bytes()
                .to_vec()),
            Self::U16Be => Ok(u16::try_from(length)
                .map_err(|_| overflow())?
                .to_be_bytes()
                .to_vec()),
            Self::U32Le => Ok(u32::try_from(length)
                .map_err(|_| overflow())?
                .to_le_bytes()
                .to_vec()),
            Self::U32Be => Ok(u32::try_from(length)
                .map_err(|_| overflow())?
                .to_be_bytes()
                .to_vec()),
        }
    }

    fn width(self) -> usize {
        match self {
            Self::U8 => 1,
            Self::U16Le | Self::U16Be => 2,
            Self::U32Le | Self::U32Be => 4,
        }
    }

    fn decode_length(self, prefix: &[u8]) -> usize {
        match self {
            Self::U8 => prefix[0] as usize,
            Self::U16Le => u16::from_le_bytes([prefix[0], prefix[1]]) as usize,
            Self::U16Be => u16::from_be_bytes([prefix[0], prefix[1]]) as usize,
            Self::U32Le => {
                u32::from_le_bytes([prefix[0], prefix[1], prefix[2], prefix[3]]) as usize
            }
            Self::U32Be => {
                u32::from_be_bytes([prefix[0], prefix[1], prefix[2], prefix[3]]) as usize
            }
        }
    }
}

struct LengthPrefixedFrameReader {
    format: LengthFormat,
    max_frame_bytes: usize,
    prefix: [u8; 4],
    prefix_read: usize,
    payload: Option<Vec<u8>>,
    payload_read: usize,
}

impl LengthPrefixedFrameReader {
    fn new(format: LengthFormat, max_frame_bytes: usize) -> Self {
        Self {
            format,
            max_frame_bytes,
            prefix: [0; 4],
            prefix_read: 0,
            payload: None,
            payload_read: 0,
        }
    }

    async fn read_frame<R>(&mut self, reader: &mut R) -> Result<Option<Vec<u8>>, TransportError>
    where
        R: tokio::io::AsyncRead + Unpin,
    {
        loop {
            if self.payload.is_none() {
                let prefix_width = self.format.width();
                if self.prefix_read < prefix_width {
                    let count = reader
                        .read(&mut self.prefix[self.prefix_read..prefix_width])
                        .await?;
                    if count == 0 {
                        if self.prefix_read == 0 {
                            return Ok(None);
                        }
                        return Err(TransportError::InvalidRequest(
                            "Unix-socket channel ended during a length prefix".to_owned(),
                        ));
                    }
                    self.prefix_read += count;
                    continue;
                }

                let length = self.format.decode_length(&self.prefix[..prefix_width]);
                if length > self.max_frame_bytes {
                    return Err(TransportError::InvalidRequest(format!(
                        "Unix-socket frame exceeds {} bytes: {length}",
                        self.max_frame_bytes
                    )));
                }
                self.payload = Some(vec![0; length]);
                self.payload_read = 0;
                if length == 0 {
                    self.prefix_read = 0;
                    return Ok(self.payload.take());
                }
            }

            let payload = self.payload.as_mut().expect("payload initialized above");
            let count = reader.read(&mut payload[self.payload_read..]).await?;
            if count == 0 {
                return Err(TransportError::InvalidRequest(
                    "Unix-socket channel ended during a length-prefixed frame".to_owned(),
                ));
            }
            self.payload_read += count;
            if self.payload_read == payload.len() {
                self.prefix_read = 0;
                self.payload_read = 0;
                return Ok(self.payload.take());
            }
        }
    }
}

async fn enqueue_unix_socket_frame(
    sender: &mpsc::Sender<OwnedInboundFrame>,
    byte_budget: &Arc<Semaphore>,
    bytes: Vec<u8>,
) -> Result<(), TransportError> {
    // A frame larger than the byte budget reserves the whole budget. This
    // permits the configured maximum frame size while ensuring that no other
    // completed frame can queue behind it.
    let byte_permits = bytes.len().clamp(1, INBOUND_DELIVERY_BYTE_CAPACITY) as u32;
    let byte_permit = byte_budget
        .clone()
        .acquire_many_owned(byte_permits)
        .await
        .map_err(|_| {
            TransportError::ChannelUnavailable(
                "Unix-socket inbound delivery queue closed".to_owned(),
            )
        })?;
    sender
        .send(OwnedInboundFrame {
            bytes,
            _byte_permit: byte_permit,
        })
        .await
        .map_err(|_| {
            TransportError::ChannelUnavailable(
                "Unix-socket inbound delivery worker stopped".to_owned(),
            )
        })
}

async fn read_unix_socket_frames<R>(
    mut socket_reader: R,
    framing: Option<LengthFormat>,
    max_frame_bytes: usize,
    sender: mpsc::Sender<OwnedInboundFrame>,
    byte_budget: Arc<Semaphore>,
) -> (String, bool)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buffer = vec![0u8; 32 * 1024];
    let mut framed_reader =
        framing.map(|format| LengthPrefixedFrameReader::new(format, max_frame_bytes));
    loop {
        let read = match &mut framed_reader {
            Some(frame_reader) => frame_reader.read_frame(&mut socket_reader).await,
            None => match socket_reader.read(&mut buffer).await {
                Ok(0) => Ok(None),
                Ok(count) => Ok(Some(buffer[..count].to_vec())),
                Err(error) => Err(error.into()),
            },
        };
        match read {
            Ok(None) => return ("remote Unix socket reached EOF".to_owned(), false),
            Err(error) => {
                return (format!("remote Unix-socket read failed: {error}"), false);
            }
            Ok(Some(bytes)) => {
                // A synchronous ATrace slice must not cross the queue's await:
                // Tokio may resume this task on another OS thread.
                {
                    let _trace = AndroidTraceSlice::begin(TERMINAL_INBOUND_RUST_FRAME_RECEIVED);
                }
                if let Err(error) = enqueue_unix_socket_frame(&sender, &byte_budget, bytes).await {
                    return (
                        format!("remote Unix-socket delivery failed: {error}"),
                        false,
                    );
                }
            }
        }
    }
}

async fn write_unix_socket_commands<W>(
    mut writer: W,
    mut receiver: mpsc::Receiver<StreamCommand>,
) -> (String, bool)
where
    W: tokio::io::AsyncWrite + Unpin,
{
    loop {
        match receiver.recv().await {
            Some(StreamCommand::Write(data)) => {
                if let Err(error) = writer.write_all(&data).await {
                    return (format!("remote Unix-socket write failed: {error}"), false);
                }
            }
            Some(StreamCommand::Close) => {
                return ("Unix-socket channel closed by client".to_owned(), true);
            }
            None => {
                return ("Unix-socket channel control queue closed".to_owned(), true);
            }
        }
    }
}

async fn deliver_unix_socket_frames(
    key: Arc<str>,
    channel_id: Arc<str>,
    delivery: UnixSocketDelivery,
    mut receiver: mpsc::Receiver<OwnedInboundFrame>,
) -> Result<(), String> {
    while let Some(frame) = receiver.recv().await {
        let OwnedInboundFrame {
            bytes,
            _byte_permit: byte_permit,
        } = frame;
        let key = Arc::clone(&key);
        let channel_id = Arc::clone(&channel_id);
        tokio::task::spawn_blocking(move || {
            // The owned frame and its byte-budget permit remain alive until
            // invokeBlocking has returned, preserving RustBuffer lifetime.
            let _byte_permit = byte_permit;
            let _trace = AndroidTraceSlice::begin(TERMINAL_INBOUND_RUST_FRAME_DELIVERY);
            match delivery {
                UnixSocketDelivery::ReactNative => {
                    emit_unix_socket_channel_data(&key, &channel_id, bytes);
                }
                UnixSocketDelivery::Native { context, frame, .. } => unsafe {
                    frame(context, bytes.as_ptr(), bytes.len());
                },
            }
        })
        .await
        .map_err(|error| format!("Unix-socket inbound delivery worker failed: {error}"))?;
    }
    Ok(())
}

async fn open_unix_socket_channel_with_framing(
    params: &Value,
    framing: Option<LengthFormat>,
    delivery: UnixSocketDelivery,
) -> Result<Value, TransportError> {
    let key = required_string(params, "key")?;
    let channel_id = required_string(params, "channelId")?;
    if channel_id.is_empty() || channel_id.len() > 128 || channel_id.chars().any(char::is_control) {
        return Err(TransportError::InvalidRequest(
            "channelId must contain 1 through 128 printable characters".to_owned(),
        ));
    }
    let map_key = (key.clone(), channel_id.clone());
    if unix_socket_channels().read().contains_key(&map_key) {
        return Err(TransportError::InvalidRequest(format!(
            "Unix-socket channel '{channel_id}' is already open"
        )));
    }

    let session = session_for(params)?;
    let socket_path = required_string(params, "socketPath")?;
    let channel = session
        .handle
        .channel_open_direct_streamlocal(socket_path)
        .await?;
    let max_frame_bytes = params
        .get("maxFrameBytes")
        .and_then(Value::as_u64)
        .unwrap_or(32 * 1024 * 1024)
        .clamp(1, 128 * 1024 * 1024) as usize;
    let (sender, receiver) = mpsc::channel(CONTROL_QUEUE_CAPACITY);
    {
        let mut channels = unix_socket_channels().write();
        if channels.contains_key(&map_key) {
            return Err(TransportError::InvalidRequest(format!(
                "Unix-socket channel '{channel_id}' is already open"
            )));
        }
        channels.insert(
            map_key.clone(),
            UnixSocketChannelHandle {
                sender: sender.clone(),
                framing,
            },
        );
    }

    tokio::spawn(async move {
        let (socket_reader, socket_writer) = tokio::io::split(channel.into_stream());
        let (delivery_sender, delivery_receiver) = mpsc::channel(INBOUND_DELIVERY_QUEUE_CAPACITY);
        let delivery_byte_budget = Arc::new(Semaphore::new(INBOUND_DELIVERY_BYTE_CAPACITY));
        let mut read_task = tokio::spawn(read_unix_socket_frames(
            socket_reader,
            framing,
            max_frame_bytes,
            delivery_sender,
            delivery_byte_budget,
        ));
        let mut write_task = tokio::spawn(write_unix_socket_commands(socket_writer, receiver));
        let delivery_task = tokio::spawn(deliver_unix_socket_frames(
            Arc::<str>::from(key.as_str()),
            Arc::<str>::from(channel_id.as_str()),
            delivery,
            delivery_receiver,
        ));

        // A blocked JS callback can stop only delivery. Reads backpressure at
        // the bounded queue, while control writes continue on their own task.
        let (reason, closed_by_client) = tokio::select! {
            result = &mut read_task => {
                write_task.abort();
                let _ = write_task.await;
                match result {
                    Ok(outcome) => outcome,
                    Err(error) => (format!("Unix-socket reader task failed: {error}"), false),
                }
            },
            result = &mut write_task => {
                read_task.abort();
                let _ = read_task.await;
                match result {
                    Ok(outcome) => outcome,
                    Err(error) => (format!("Unix-socket writer task failed: {error}"), false),
                }
            },
        };
        let should_remove = unix_socket_channels()
            .read()
            .get(&map_key)
            .is_some_and(|current| current.sender.same_channel(&sender));
        if should_remove {
            unix_socket_channels().write().remove(&map_key);
        }
        // Dropping/aborting the reader closes delivery_sender. Drain all owned
        // frames before reporting closure so data and close ordering is stable.
        let delivery_reason = match delivery_task.await {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(error),
            Err(error) => Some(format!("Unix-socket delivery task failed: {error}")),
        };
        let reason = delivery_reason.unwrap_or(reason);
        match delivery {
            UnixSocketDelivery::ReactNative => emit_event(json!({
                "name": "UnixSocketChannel",
                "key": key,
                "value": {
                    "type": "closed",
                    "channelId": channel_id,
                    "reason": reason,
                    "closedByClient": closed_by_client,
                },
            })),
            UnixSocketDelivery::Native {
                context, closed, ..
            } => match CString::new(reason) {
                Ok(reason) => unsafe { closed(context, reason.as_ptr()) },
                Err(_) => unsafe { closed(context, c"native Unix-socket channel closed".as_ptr()) },
            },
        }
    });

    Ok(Value::Null)
}

async fn open_unix_socket_channel(params: &Value) -> Result<Value, TransportError> {
    open_unix_socket_channel_with_framing(params, None, UnixSocketDelivery::ReactNative).await
}

async fn open_length_prefixed_unix_socket_channel(params: &Value) -> Result<Value, TransportError> {
    let format = LengthFormat::parse(&required_string(params, "lengthFormat")?)?;
    open_unix_socket_channel_with_framing(params, Some(format), UnixSocketDelivery::ReactNative)
        .await
}

fn unix_socket_channel_command_for_key(
    key: &str,
    channel_id: &str,
    command: StreamCommand,
) -> Result<(), TransportError> {
    let handle = unix_socket_channels()
        .read()
        .get(&(key.to_owned(), channel_id.to_owned()))
        .cloned()
        .ok_or_else(|| {
            TransportError::ChannelUnavailable(format!(
                "Unix-socket channel '{channel_id}' is not open"
            ))
        })?;
    handle.sender.try_send(command).map_err(|error| {
        TransportError::ChannelUnavailable(format!(
            "Unix-socket channel '{channel_id}' rejected input: {error}"
        ))
    })?;
    Ok(())
}

fn write_unix_socket_channel_for_key(
    key: &str,
    channel_id: &str,
    bytes: Vec<u8>,
    framed: bool,
) -> Result<(), TransportError> {
    let handle = unix_socket_channels()
        .read()
        .get(&(key.to_owned(), channel_id.to_owned()))
        .cloned()
        .ok_or_else(|| {
            TransportError::ChannelUnavailable(format!(
                "Unix-socket channel '{channel_id}' is not open"
            ))
        })?;
    let data = match (handle.framing, framed) {
        (None, false) => bytes,
        (Some(format), true) => {
            let mut framed_bytes = format.prefix(bytes.len())?;
            framed_bytes.extend_from_slice(&bytes);
            framed_bytes
        }
        (Some(_), false) => {
            return Err(TransportError::InvalidRequest(format!(
                "Unix-socket channel '{channel_id}' requires framed writes"
            )));
        }
        (None, true) => {
            return Err(TransportError::InvalidRequest(format!(
                "Unix-socket channel '{channel_id}' is not length-prefixed"
            )));
        }
    };
    handle
        .sender
        .try_send(StreamCommand::Write(data))
        .map_err(|error| {
            TransportError::ChannelUnavailable(format!(
                "Unix-socket channel '{channel_id}' rejected input: {error}"
            ))
        })
}

fn close_unix_socket_channel(params: &Value) -> Result<Value, TransportError> {
    let key = required_string(params, "key")?;
    let channel_id = required_string(params, "channelId")?;
    unix_socket_channel_command_for_key(&key, &channel_id, StreamCommand::Close)?;
    Ok(Value::Null)
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

#[derive(Debug, PartialEq, Eq)]
struct SftpHttpRequest {
    head: bool,
    path: String,
    range: Option<String>,
}

fn parse_sftp_http_request(bytes: &[u8]) -> Result<SftpHttpRequest, TransportError> {
    let text = std::str::from_utf8(bytes).map_err(|_| {
        TransportError::InvalidRequest("file preview request was not valid HTTP".to_owned())
    })?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let path = parts.next().unwrap_or_default();
    let version = parts.next().unwrap_or_default();
    if parts.next().is_some()
        || !matches!(method, "GET" | "HEAD")
        || !version.starts_with("HTTP/1.")
        || !path.starts_with('/')
    {
        return Err(TransportError::InvalidRequest(
            "file preview request was not a supported HTTP GET or HEAD".to_owned(),
        ));
    }
    let range = lines.find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("range")
            .then(|| value.trim().to_owned())
    });
    Ok(SftpHttpRequest {
        head: method == "HEAD",
        path: path.to_owned(),
        range,
    })
}

fn parse_sftp_http_range(value: Option<&str>, size: u64) -> Result<(u64, u64, bool), ()> {
    let Some(value) = value else {
        return Ok((0, size.saturating_sub(1), false));
    };
    let range = value.strip_prefix("bytes=").ok_or(())?;
    if size == 0 || range.contains(',') {
        return Err(());
    }
    let (start, end) = range.split_once('-').ok_or(())?;
    let (start, end) = if start.is_empty() {
        let suffix = end.parse::<u64>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start = start.parse::<u64>().map_err(|_| ())?;
        let end = if end.is_empty() {
            size - 1
        } else {
            end.parse::<u64>().map_err(|_| ())?.min(size - 1)
        };
        (start, end)
    };
    if start >= size || end < start {
        return Err(());
    }
    Ok((start, end, true))
}

fn sftp_http_content_type(remote_path: &str) -> &'static str {
    let extension = remote_path
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "3gp" => "video/3gpp",
        "aac" => "audio/aac",
        "avi" => "video/x-msvideo",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "m4v" => "video/mp4",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "oga" | "ogg" => "audio/ogg",
        "opus" => "audio/ogg",
        "pdf" => "application/pdf",
        "wav" => "audio/wav",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

async fn write_sftp_http_error(
    stream: &mut tokio::net::TcpStream,
    status: &str,
    extra_headers: &str,
) -> Result<(), TransportError> {
    let body = format!("{status}\n");
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n{extra_headers}\r\n{body}",
        body.len(),
    );
    stream.write_all(response.as_bytes()).await?;
    Ok(())
}

async fn stream_sftp_http_range(
    stream: &mut tokio::net::TcpStream,
    sftp: Arc<SftpSession>,
    remote_path: &str,
    start: u64,
    end: u64,
) -> Result<(), TransportError> {
    let total_chunks = (end - start + SFTP_HTTP_READ_SIZE) / SFTP_HTTP_READ_SIZE;
    let parallelism = usize::try_from(total_chunks)
        .unwrap_or(SFTP_HTTP_PIPELINE_DEPTH)
        .clamp(1, SFTP_HTTP_PIPELINE_DEPTH);
    let opens = (0..parallelism).map(|_| sftp.open(remote_path.to_owned()));
    let mut files = try_join_all(opens).await?;
    let mut offset = start;
    while offset <= end {
        let specs = (0..parallelism)
            .scan(offset, |next, _| {
                if *next > end {
                    return None;
                }
                let length = (end - *next + 1).min(SFTP_HTTP_READ_SIZE);
                let spec = (*next, length);
                *next += length;
                Some(spec)
            })
            .collect::<Vec<_>>();
        let reads =
            files
                .iter_mut()
                .zip(specs.iter())
                .map(|(file, (position, length))| async move {
                    file.seek(SeekFrom::Start(*position)).await?;
                    let mut bytes = vec![0u8; *length as usize];
                    file.read_exact(&mut bytes).await?;
                    Ok::<Vec<u8>, std::io::Error>(bytes)
                });
        let chunks = try_join_all(reads).await?;
        for chunk in chunks {
            stream.write_all(&chunk).await?;
        }
        offset += specs.iter().map(|(_, length)| length).sum::<u64>();
    }
    for file in &mut files {
        let _ = file.shutdown().await;
    }
    Ok(())
}

async fn serve_sftp_http_connection(
    mut stream: tokio::net::TcpStream,
    sftp: Arc<SftpSession>,
    remote_path: String,
    token: String,
    size: u64,
) -> Result<(), TransportError> {
    let mut request_bytes = Vec::with_capacity(1024);
    loop {
        let mut bytes = [0u8; 1024];
        let count = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut bytes))
            .await
            .map_err(|_| {
                TransportError::InvalidRequest("timed out reading file preview request".to_owned())
            })??;
        if count == 0 {
            return Ok(());
        }
        request_bytes.extend_from_slice(&bytes[..count]);
        if request_bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if request_bytes.len() > SFTP_HTTP_HEADER_LIMIT {
            write_sftp_http_error(&mut stream, "431 Request Header Fields Too Large", "").await?;
            return Ok(());
        }
    }

    let request = match parse_sftp_http_request(&request_bytes) {
        Ok(request) => request,
        Err(_) => {
            write_sftp_http_error(&mut stream, "400 Bad Request", "").await?;
            return Ok(());
        }
    };
    if !request.path.starts_with(&format!("/{token}/")) {
        write_sftp_http_error(&mut stream, "404 Not Found", "").await?;
        return Ok(());
    }
    let (start, end, partial) = match parse_sftp_http_range(request.range.as_deref(), size) {
        Ok(range) => range,
        Err(()) => {
            write_sftp_http_error(
                &mut stream,
                "416 Range Not Satisfiable",
                &format!("Content-Range: bytes */{size}\r\n"),
            )
            .await?;
            return Ok(());
        }
    };
    let content_length = if size == 0 { 0 } else { end - start + 1 };
    let range_header = if partial {
        format!("Content-Range: bytes {start}-{end}/{size}\r\n")
    } else {
        String::new()
    };
    let status = if partial {
        "206 Partial Content"
    } else {
        "200 OK"
    };
    let headers = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {}\r\nContent-Length: {content_length}\r\nAccept-Ranges: bytes\r\n{range_header}Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        sftp_http_content_type(&remote_path),
    );
    stream.write_all(headers.as_bytes()).await?;
    if !request.head && content_length > 0 {
        stream_sftp_http_range(&mut stream, sftp, &remote_path, start, end).await?;
    }
    Ok(())
}

async fn start_sftp_file_server(params: &Value) -> Result<Value, TransportError> {
    let key = required_string(params, "key")?;
    let remote_path = required_string(params, "remotePath")?;
    let session = session_for(params)?;
    let channel = session.handle.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    let sftp = Arc::new(SftpSession::new(channel.into_stream()).await?);
    let metadata = sftp.metadata(remote_path.clone()).await?;
    if metadata.is_dir() {
        return Err(TransportError::InvalidRequest(
            "cannot stream a remote directory".to_owned(),
        ));
    }
    let size = metadata.size.unwrap_or_default();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let local_port = listener.local_addr()?.port();
    let mut token_bytes = [0u8; 16];
    russh::keys::ssh_key::getrandom::fill(&mut token_bytes).map_err(|error| {
        TransportError::InvalidRequest(format!("could not secure file preview: {error}"))
    })?;
    let token = token_bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let (cancel_tx, mut cancel_rx) = watch::channel(false);
    sftp_file_servers()
        .write()
        .insert((key.clone(), local_port), cancel_tx.clone());
    let returned_token = token.clone();
    tokio::spawn(async move {
        let lifetime = tokio::time::sleep(SFTP_HTTP_SERVER_LIFETIME);
        tokio::pin!(lifetime);
        loop {
            tokio::select! {
                changed = cancel_rx.changed() => {
                    if changed.is_err() || *cancel_rx.borrow() { break; }
                },
                _ = &mut lifetime => break,
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { break };
                    let mut connection_cancel = cancel_rx.clone();
                    let connection_sftp = sftp.clone();
                    let connection_path = remote_path.clone();
                    let connection_token = token.clone();
                    tokio::spawn(async move {
                        tokio::select! {
                            _ = connection_cancel.changed() => {},
                            _ = serve_sftp_http_connection(
                                stream,
                                connection_sftp,
                                connection_path,
                                connection_token,
                                size,
                            ) => {},
                        }
                    });
                }
            }
        }
        let _ = sftp.close().await;
        let map_key = (key, local_port);
        let should_remove = sftp_file_servers()
            .read()
            .get(&map_key)
            .is_some_and(|current| current.same_channel(&cancel_tx));
        if should_remove {
            sftp_file_servers().write().remove(&map_key);
        }
    });
    Ok(json!({ "localPort": local_port, "token": returned_token }))
}

fn emit_exec_channel_data(key: &str, channel_id: &str, bytes: Vec<u8>) {
    let sink = uniffi_event_sink().read().clone();
    let callback = *event_callback().read();
    let legacy_json = callback.map(|_| {
        serde_json::to_string(&json!({
            "name": "ExecChannel",
            "key": key,
            "value": {
                "type": "data",
                "channelId": channel_id,
                "bytes": BASE64.encode(&bytes),
            },
        }))
        .unwrap_or_default()
    });
    if let Some(sink) = sink {
        let _trace = AndroidTraceSlice::begin(EXEC_INBOUND_RUST_CHUNK_DELIVERY);
        sink.exec_channel_data(key.to_owned(), channel_id.to_owned(), bytes);
    }
    if let (Some(callback), Some(json)) = (callback, legacy_json) {
        emit_legacy_json(callback, json);
    }
}

async fn open_exec_channel(params: &Value) -> Result<Value, TransportError> {
    let key = required_string(params, "key")?;
    let channel_id = required_string(params, "channelId")?;
    if channel_id.is_empty() || channel_id.len() > 128 || channel_id.chars().any(char::is_control) {
        return Err(TransportError::InvalidRequest(
            "channelId must contain 1 through 128 printable characters".to_owned(),
        ));
    }
    let map_key = (key.clone(), channel_id.clone());
    if exec_channels().read().contains_key(&map_key) {
        return Err(TransportError::InvalidRequest(format!(
            "exec channel '{channel_id}' is already open"
        )));
    }
    let session = session_for(params)?;
    let channel = session.handle.channel_open_session().await?;
    request_agent_forwarding(&session, &channel).await?;
    channel
        .exec(true, required_string(params, "command")?)
        .await?;
    let (sender, mut receiver) = mpsc::channel(CONTROL_QUEUE_CAPACITY);
    {
        let mut channels = exec_channels().write();
        if channels.contains_key(&map_key) {
            return Err(TransportError::InvalidRequest(format!(
                "exec channel '{channel_id}' is already open"
            )));
        }
        channels.insert(map_key.clone(), sender.clone());
    }
    tokio::spawn(async move {
        let mut stream = channel.into_stream();
        let mut buffer = vec![0u8; 8192];
        let (reason, closed_by_client) = loop {
            tokio::select! {
                read = stream.read(&mut buffer) => match read {
                    Ok(0) => break ("remote exec channel reached EOF".to_owned(), false),
                    Err(error) => break (format!("remote exec-channel read failed: {error}"), false),
                    Ok(count) => {
                        {
                            let _trace = AndroidTraceSlice::begin(EXEC_INBOUND_RUST_CHUNK_RECEIVED);
                        }
                        emit_exec_channel_data(
                            &key,
                            &channel_id,
                            buffer[..count].to_vec(),
                        );
                    }
                },
                command = receiver.recv() => match command {
                    Some(StreamCommand::Write(data)) => if let Err(error) = stream.write_all(&data).await {
                        break (format!("remote exec-channel write failed: {error}"), false);
                    },
                    Some(StreamCommand::Close) => break ("exec channel closed by client".to_owned(), true),
                    None => break ("exec-channel control queue closed".to_owned(), true),
                }
            }
        };
        let should_remove = exec_channels()
            .read()
            .get(&map_key)
            .is_some_and(|current| current.same_channel(&sender));
        if should_remove {
            exec_channels().write().remove(&map_key);
        }
        emit_event(json!({
            "name": "ExecChannel",
            "key": key,
            "value": {
                "type": "closed",
                "channelId": channel_id,
                "reason": reason,
                "closedByClient": closed_by_client,
            },
        }));
    });
    Ok(Value::Null)
}

fn exec_channel_command_for_key(
    key: &str,
    channel_id: &str,
    command: StreamCommand,
) -> Result<(), TransportError> {
    let sender = exec_channels()
        .read()
        .get(&(key.to_owned(), channel_id.to_owned()))
        .cloned()
        .ok_or_else(|| {
            TransportError::ChannelUnavailable(format!("exec channel '{channel_id}' is not open"))
        })?;
    sender.try_send(command).map_err(|error| {
        TransportError::ChannelUnavailable(format!(
            "exec channel '{channel_id}' rejected input: {error}"
        ))
    })
}

fn close_exec_channel(params: &Value) -> Result<Value, TransportError> {
    let key = required_string(params, "key")?;
    let channel_id = required_string(params, "channelId")?;
    exec_channel_command_for_key(&key, &channel_id, StreamCommand::Close)?;
    Ok(Value::Null)
}

async fn disconnect_key(key: String) {
    let channel_ids = unix_socket_channels()
        .read()
        .keys()
        .filter_map(|(owner, channel_id)| (owner == &key).then_some(channel_id.clone()))
        .collect::<Vec<_>>();
    for channel_id in channel_ids {
        if let Some(handle) = unix_socket_channels()
            .write()
            .remove(&(key.clone(), channel_id))
        {
            let _ = handle.sender.try_send(StreamCommand::Close);
        }
    }
    let exec_channel_ids = exec_channels()
        .read()
        .keys()
        .filter_map(|(owner, channel_id)| (owner == &key).then_some(channel_id.clone()))
        .collect::<Vec<_>>();
    for channel_id in exec_channel_ids {
        if let Some(sender) = exec_channels().write().remove(&(key.clone(), channel_id)) {
            let _ = sender.try_send(StreamCommand::Close);
        }
    }
    if let Some(cancel) = transfers().read().get(&(key.clone(), "upload")) {
        let _ = cancel.send(true);
    }
    if let Some(cancel) = transfers().read().get(&(key.clone(), "download")) {
        let _ = cancel.send(true);
    }
    if let Some(sender) = shells().write().remove(&key) {
        let _ = sender.try_send(ShellCommand::Close);
    }
    let file_server_ports = sftp_file_servers()
        .read()
        .keys()
        .filter_map(|(owner, port)| (owner == &key).then_some(*port))
        .collect::<Vec<_>>();
    for port in file_server_ports {
        if let Some(cancel) = sftp_file_servers().write().remove(&(key.clone(), port)) {
            let _ = cancel.send(true);
        }
    }
    let removed_sftp = { sftp_sessions().write().remove(&key) };
    if let Some(sftp) = removed_sftp {
        let _ = sftp.close().await;
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
        "sftpCreateDirAll" => sftp_create_dir_all(&request.params).await,
        "sftpRm" => sftp_mutation(&request.params, "rm").await,
        "sftpRmdir" => sftp_mutation(&request.params, "rmdir").await,
        "sftpChmod" => sftp_mutation(&request.params, "chmod").await,
        "sftpUpload" => sftp_transfer(&request.params, true, false).await,
        "sftpUploadToPath" => sftp_transfer(&request.params, true, true).await,
        "sftpDownload" => sftp_transfer(&request.params, false, false).await,
        "startSftpFileServer" => start_sftp_file_server(&request.params).await,
        "closeSftpFileServer" => {
            let key = required_string(&request.params, "key")?;
            let port = required_u16(&request.params, "localPort")?;
            if let Some(cancel) = sftp_file_servers().write().remove(&(key, port)) {
                let _ = cancel.send(true);
            }
            Ok(Value::Null)
        }
        "sftpCancelUpload" | "sftpCancelDownload" => {
            let key = required_string(&request.params, "key")?;
            let direction = if request.operation.ends_with("Upload") {
                "upload"
            } else {
                "download"
            };
            if let Some(cancel) = transfers().read().get(&(key, direction)) {
                let _ = cancel.send(true);
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
        "openUnixSocketChannel" => open_unix_socket_channel(&request.params).await,
        "openLengthPrefixedUnixSocketChannel" => {
            open_length_prefixed_unix_socket_channel(&request.params).await
        }
        "closeUnixSocketChannel" => close_unix_socket_channel(&request.params),
        "requestUnixSocket" => request_unix_socket(&request.params).await,
        "openExecChannel" => open_exec_channel(&request.params).await,
        "closeExecChannel" => close_exec_channel(&request.params),
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
        format!(
            r#"{{"ok":false,"error":{{"code":"UNKNOWN","message":"response serialization failed: {error}"}}}}"#
        )
    })
}

async fn dispatch_json(input: &str) -> String {
    let response = match serde_json::from_str::<Request>(input) {
        Ok(request) => match dispatch(request).await {
            Ok(value) => Response::success(value),
            Err(error) => Response::failure(error),
        },
        Err(error) => Response::failure(SshError::new(
            SshErrorCode::InvalidRequest,
            format!("invalid request JSON: {error}"),
        )),
    };
    serialize_response(&response)
}

async fn process_json_async(input: &str) -> String {
    match AssertUnwindSafe(dispatch_json(input)).catch_unwind().await {
        Ok(response) => response,
        Err(_) => serialize_response(&Response::failure(SshError::unknown(
            "Rust SSH operation panicked",
        ))),
    }
}

fn process_json(input: &str) -> String {
    match runtime() {
        Ok(runtime) => runtime.block_on(process_json_async(input)),
        Err(error) => serialize_response(&Response::failure(SshError::unknown(format!(
            "failed to initialize SSH runtime: {error}"
        )))),
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
        None => serialize_response(&Response::failure(SshError::new(
            SshErrorCode::InvalidRequest,
            "request pointer was null",
        ))),
    };
    if LIFECYCLE_EPOCH.load(Ordering::Acquire) != lifecycle_epoch {
        if let Some(key) = request_key {
            disconnect_key(key).await;
        }
        response = serialize_response(&Response::failure(SshError::new(
            SshErrorCode::SessionClosed,
            "Rust SSH bridge was invalidated",
        )));
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
            return serialize_response(&Response::failure(SshError::unknown(format!(
                "failed to initialize SSH runtime: {error}"
            ))));
        }
    };
    match task.await {
        Ok(response) => response,
        Err(error) => serialize_response(&Response::failure(SshError::unknown(format!(
            "SSH runtime task failed: {error}"
        )))),
    }
}

fn fast_path_result(result: Result<(), TransportError>) -> Option<String> {
    result
        .err()
        .map(SshError::from)
        .and_then(|error| serde_json::to_string(&error).ok())
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
pub fn write_unix_socket_channel(
    key: String,
    channel_id: String,
    bytes: Vec<u8>,
) -> Option<String> {
    fast_path_result(write_unix_socket_channel_for_key(
        &key,
        &channel_id,
        bytes,
        false,
    ))
}

#[uniffi::export]
pub fn write_length_prefixed_unix_socket_channel(
    key: String,
    channel_id: String,
    bytes: Vec<u8>,
) -> Option<String> {
    fast_path_result(write_unix_socket_channel_for_key(
        &key,
        &channel_id,
        bytes,
        true,
    ))
}

#[uniffi::export]
pub fn write_exec_channel(key: String, channel_id: String, bytes: Vec<u8>) -> Option<String> {
    fast_path_result(exec_channel_command_for_key(
        &key,
        &channel_id,
        StreamCommand::Write(bytes),
    ))
}

#[uniffi::export]
pub fn set_event_sink(sink: Arc<dyn ReactNativeRusshEventSink>) {
    *uniffi_event_sink().write() = Some(sink);
}

#[uniffi::export]
pub fn clear_event_sink() {
    *uniffi_event_sink().write() = None;
}

/// Executes one transport operation. The caller owns the returned UTF-8 string
/// and must release it with [`react_native_russh_string_free`].
///
/// # Safety
///
/// `request_json` must be null or point to a valid NUL-terminated byte string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn react_native_russh_call(request_json: *const c_char) -> *mut c_char {
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
pub unsafe extern "C" fn react_native_russh_call_async(
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
            let response = serialize_response(&Response::failure(SshError::unknown(format!(
                "failed to initialize SSH runtime: {error}"
            ))));
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

/// Releases a string previously returned by [`react_native_russh_call`].
///
/// # Safety
///
/// `value` must be null or a pointer returned by [`react_native_russh_call`] that has not
/// already been released.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn react_native_russh_string_free(value: *mut c_char) {
    if !value.is_null() {
        drop(unsafe { CString::from_raw(value) });
    }
}

/// Registers the process-wide event sink. Passing `None` detaches it.
#[unsafe(no_mangle)]
pub extern "C" fn react_native_russh_set_event_callback(callback: Option<EventCallback>) {
    *event_callback().write() = callback;
}

fn native_channel_result(error: Option<impl ToString>) -> *mut c_char {
    let Some(error) = error else {
        return std::ptr::null_mut();
    };
    CString::new(error.to_string())
        .unwrap_or_else(|_| CString::new("native Unix-socket operation failed").unwrap())
        .into_raw()
}

fn notify_native_channel_open(
    callback: NativeChannelOpenCallback,
    context: u64,
    result: Result<Value, TransportError>,
) {
    match result {
        Ok(_) => unsafe { callback(context, std::ptr::null()) },
        Err(error) => match CString::new(error.to_string()) {
            Ok(error) => unsafe { callback(context, error.as_ptr()) },
            Err(_) => unsafe { callback(context, c"native Unix-socket open failed".as_ptr()) },
        },
    }
}

#[allow(clippy::too_many_arguments)]
unsafe fn open_native_unix_socket_channel(
    context: u64,
    key: *const c_char,
    channel_id: *const c_char,
    socket_path: *const c_char,
    max_frame_bytes: usize,
    opened: Option<NativeChannelOpenCallback>,
    frame: Option<NativeChannelFrameCallback>,
    closed: Option<NativeChannelClosedCallback>,
    framing: Option<LengthFormat>,
) {
    let Some(opened) = opened else { return };
    let strings = [key, channel_id, socket_path]
        .into_iter()
        .map(|value| {
            if value.is_null() {
                Err(TransportError::InvalidRequest(
                    "native Unix-socket channel received a null string".to_owned(),
                ))
            } else {
                Ok(unsafe { CStr::from_ptr(value) }
                    .to_string_lossy()
                    .into_owned())
            }
        })
        .collect::<Result<Vec<_>, _>>();
    let [key, channel_id, socket_path] = match strings.and_then(|strings| {
        strings.try_into().map_err(|_| {
            TransportError::InvalidRequest("native Unix-socket arguments were invalid".to_owned())
        })
    }) {
        Ok(strings) => strings,
        Err(error) => {
            notify_native_channel_open(opened, context, Err(error));
            return;
        }
    };
    let (Some(frame), Some(closed)) = (frame, closed) else {
        notify_native_channel_open(
            opened,
            context,
            Err(TransportError::InvalidRequest(
                "native Unix-socket callbacks are required".to_owned(),
            )),
        );
        return;
    };
    let runtime = match runtime() {
        Ok(runtime) => runtime,
        Err(error) => {
            notify_native_channel_open(
                opened,
                context,
                Err(TransportError::ChannelUnavailable(format!(
                    "failed to initialize SSH runtime: {error}"
                ))),
            );
            return;
        }
    };
    runtime.spawn(async move {
        let params = json!({
            "key": key,
            "channelId": channel_id,
            "socketPath": socket_path,
            "maxFrameBytes": max_frame_bytes,
        });
        let result = open_unix_socket_channel_with_framing(
            &params,
            framing,
            UnixSocketDelivery::Native {
                context,
                frame,
                closed,
            },
        )
        .await;
        notify_native_channel_open(opened, context, result);
    });
}

/// Opens a product-neutral raw stream-local channel and delivers byte chunks
/// directly to native callbacks.
///
/// # Safety
///
/// String pointers must reference valid NUL-terminated UTF-8 for the duration
/// of this call. Callback functions must remain valid until `closed` fires.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn react_native_russh_open_native_unix_socket_channel(
    context: u64,
    key: *const c_char,
    channel_id: *const c_char,
    socket_path: *const c_char,
    max_frame_bytes: usize,
    opened: Option<NativeChannelOpenCallback>,
    frame: Option<NativeChannelFrameCallback>,
    closed: Option<NativeChannelClosedCallback>,
) {
    unsafe {
        open_native_unix_socket_channel(
            context,
            key,
            channel_id,
            socket_path,
            max_frame_bytes,
            opened,
            frame,
            closed,
            None,
        );
    }
}

/// Opens a product-neutral u32-LE length-prefixed stream-local channel and
/// delivers its payload frames directly to native callbacks.
///
/// This API intentionally contains no product protocol knowledge. It exists so
/// product-native codecs can reuse the already-connected SSH session without a
/// JavaScript frame round trip.
///
/// # Safety
///
/// String pointers must reference valid NUL-terminated UTF-8 for the duration
/// of this call. Callback functions must remain valid until `closed` fires.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn react_native_russh_open_native_length_prefixed_unix_socket_channel(
    context: u64,
    key: *const c_char,
    channel_id: *const c_char,
    socket_path: *const c_char,
    max_frame_bytes: usize,
    opened: Option<NativeChannelOpenCallback>,
    frame: Option<NativeChannelFrameCallback>,
    closed: Option<NativeChannelClosedCallback>,
) {
    unsafe {
        open_native_unix_socket_channel(
            context,
            key,
            channel_id,
            socket_path,
            max_frame_bytes,
            opened,
            frame,
            closed,
            Some(LengthFormat::U32Le),
        );
    }
}

fn notify_native_unix_socket_request(
    callback: NativeUnixSocketRequestCallback,
    context: u64,
    result: Result<Vec<u8>, TransportError>,
) {
    match result {
        Ok(response) => unsafe {
            callback(context, response.as_ptr(), response.len(), std::ptr::null());
        },
        Err(error) => match CString::new(error.to_string()) {
            Ok(error) => unsafe {
                callback(context, std::ptr::null(), 0, error.as_ptr());
            },
            Err(_) => unsafe {
                callback(
                    context,
                    std::ptr::null(),
                    0,
                    c"native Unix-socket request failed".as_ptr(),
                );
            },
        },
    }
}

/// Sends one byte request over a product-neutral stream-local channel and
/// returns the bytes before the configured single-byte response terminator.
///
/// # Safety
///
/// String pointers must be valid NUL-terminated UTF-8. `request` must reference
/// `request_length` readable bytes when nonzero. The callback must remain valid
/// until it is invoked once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn react_native_russh_request_native_unix_socket(
    context: u64,
    key: *const c_char,
    socket_path: *const c_char,
    request: *const u8,
    request_length: usize,
    response_terminator: u8,
    timeout_ms: u64,
    max_response_bytes: usize,
    callback: Option<NativeUnixSocketRequestCallback>,
) {
    let Some(callback) = callback else { return };
    if key.is_null()
        || socket_path.is_null()
        || (request.is_null() && request_length != 0)
        || response_terminator == 0
        || !response_terminator.is_ascii()
    {
        notify_native_unix_socket_request(
            callback,
            context,
            Err(TransportError::InvalidRequest(
                "invalid native Unix-socket request arguments".to_owned(),
            )),
        );
        return;
    }
    let key = unsafe { CStr::from_ptr(key) }
        .to_string_lossy()
        .into_owned();
    let socket_path = unsafe { CStr::from_ptr(socket_path) }
        .to_string_lossy()
        .into_owned();
    let request = if request_length == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(request, request_length) }.to_vec()
    };
    let runtime = match runtime() {
        Ok(runtime) => runtime,
        Err(error) => {
            notify_native_unix_socket_request(
                callback,
                context,
                Err(TransportError::ChannelUnavailable(format!(
                    "failed to initialize SSH runtime: {error}"
                ))),
            );
            return;
        }
    };
    runtime.spawn(async move {
        let terminator = char::from(response_terminator).to_string();
        let params = json!({
            "key": key,
            "socketPath": socket_path,
            "responseTerminator": terminator,
            "timeoutMs": timeout_ms,
            "maxResponseBytes": max_response_bytes,
        });
        let result = request_unix_socket_bytes(&params, &request).await;
        notify_native_unix_socket_request(callback, context, result);
    });
}

unsafe fn write_native_unix_socket_channel(
    key: *const c_char,
    channel_id: *const c_char,
    bytes: *const u8,
    length: usize,
    framed: bool,
) -> *mut c_char {
    if key.is_null() || channel_id.is_null() || (bytes.is_null() && length != 0) {
        return native_channel_result(Some("invalid native Unix-socket write arguments"));
    }
    let key = unsafe { CStr::from_ptr(key) }.to_string_lossy();
    let channel_id = unsafe { CStr::from_ptr(channel_id) }.to_string_lossy();
    let bytes = if length == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(bytes, length) }.to_vec()
    };
    native_channel_result(write_unix_socket_channel_for_key(&key, &channel_id, bytes, framed).err())
}

/// Queues bytes for a native raw stream-local channel.
///
/// # Safety
///
/// String pointers must be valid NUL-terminated strings. `bytes` must reference
/// `length` readable bytes when `length` is nonzero.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn react_native_russh_write_native_unix_socket_channel(
    key: *const c_char,
    channel_id: *const c_char,
    bytes: *const u8,
    length: usize,
) -> *mut c_char {
    unsafe { write_native_unix_socket_channel(key, channel_id, bytes, length, false) }
}

/// Queues one payload for a native u32-LE length-prefixed channel.
///
/// The returned string is null on success and otherwise must be released with
/// [`react_native_russh_string_free`].
///
/// # Safety
///
/// String pointers must be valid NUL-terminated strings. `bytes` must reference
/// `length` readable bytes when `length` is nonzero.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn react_native_russh_write_native_length_prefixed_unix_socket_channel(
    key: *const c_char,
    channel_id: *const c_char,
    bytes: *const u8,
    length: usize,
) -> *mut c_char {
    unsafe { write_native_unix_socket_channel(key, channel_id, bytes, length, true) }
}

/// Closes a native Unix-socket channel.
///
/// The returned string is null on success and otherwise must be released with
/// [`react_native_russh_string_free`].
///
/// # Safety
///
/// String pointers must be valid NUL-terminated strings.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn react_native_russh_close_native_unix_socket_channel(
    key: *const c_char,
    channel_id: *const c_char,
) -> *mut c_char {
    if key.is_null() || channel_id.is_null() {
        return native_channel_result(Some("invalid native Unix-socket close arguments"));
    }
    let key = unsafe { CStr::from_ptr(key) }.to_string_lossy();
    let channel_id = unsafe { CStr::from_ptr(channel_id) }.to_string_lossy();
    native_channel_result(
        unix_socket_channel_command_for_key(&key, &channel_id, StreamCommand::Close).err(),
    )
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
pub extern "C" fn react_native_russh_shutdown() {
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
        assert_eq!(result["error"]["code"], "INVALID_REQUEST");
        assert!(
            result["error"]["message"]
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
        assert_eq!(result["error"]["code"], "INVALID_REQUEST");
        assert!(
            result["error"]["message"]
                .as_str()
                .unwrap()
                .contains("missing string parameter 'key'")
        );
    }

    #[test]
    fn transport_errors_have_stable_codes() {
        assert_eq!(
            transport_error_code(&TransportError::AuthenticationFailed),
            SshErrorCode::AuthenticationFailed,
        );
        assert_eq!(
            transport_error_code(&TransportError::Io(std::io::Error::from(
                std::io::ErrorKind::ConnectionRefused,
            ))),
            SshErrorCode::ConnectionRefused,
        );
        assert_eq!(
            transport_error_code(&TransportError::Ssh(russh::Error::WrongChannel)),
            SshErrorCode::ChannelUnavailable,
        );
        assert!(matches!(
            classify_direct_connect_error(TransportError::Ssh(russh::Error::IO(
                std::io::Error::other("host lookup failed"),
            ))),
            TransportError::HostUnreachable(_),
        ));
    }

    #[test]
    fn host_key_errors_carry_structured_challenges() {
        let mut rng =
            russh::keys::ssh_key::rand_core::UnwrapErr(russh::keys::ssh_key::getrandom::SysRng);
        let private_key =
            russh::keys::PrivateKey::random(&mut rng, russh::keys::Algorithm::Ed25519).unwrap();
        let challenge =
            match KnownHosts::default().check("Example.COM", 2222, private_key.public_key()) {
                HostKeyDecision::Unknown(challenge) => challenge,
                _ => panic!("empty known_hosts should reject the key as unknown"),
            };
        let error = serde_json::to_value(SshError::from(TransportError::HostKeyUnknown(challenge)))
            .unwrap();
        assert_eq!(error["code"], "HOST_KEY_UNKNOWN");
        assert_eq!(error["details"]["host"], "Example.COM");
        assert_eq!(error["details"]["port"], 2222);
        assert_eq!(error["details"]["keyType"], "ssh-ed25519");
        assert!(
            error["details"]["fingerprint"]
                .as_str()
                .unwrap()
                .starts_with("SHA256:")
        );
        assert!(
            error["details"]["publicKey"]
                .as_str()
                .unwrap()
                .starts_with("ssh-ed25519 ")
        );
    }

    #[test]
    fn remote_home_command_expands_without_literal_quotes() {
        assert_eq!(REMOTE_HOME_COMMAND, "printf %s \"$HOME\"");
    }

    #[test]
    fn blocked_transfer_io_cancels_promptly_and_does_not_poison_the_next_transfer() {
        runtime().unwrap().block_on(async {
            let (blocked_destination, _blocked_reader) = tokio::io::duplex(1);
            let (cancel_sender, mut cancel) = watch::channel(false);
            let transfer = tokio::spawn(async move {
                copy_sftp_stream(
                    Box::new(std::io::Cursor::new(vec![7u8; 64 * 1024])),
                    Box::new(blocked_destination),
                    64 * 1024,
                    "test-client",
                    "upload",
                    "UploadProgress",
                    &mut cancel,
                )
                .await
            });

            // The one-byte duplex capacity leaves write_all blocked in the
            // middle of its first chunk until cancellation wins the select.
            tokio::time::sleep(Duration::from_millis(10)).await;
            cancel_sender.send(true).unwrap();
            let error = tokio::time::timeout(Duration::from_millis(100), transfer)
                .await
                .expect("cancelled transfer should settle promptly")
                .unwrap()
                .unwrap_err();
            assert!(error.to_string().contains("cancelled"));

            let (_next_cancel_sender, mut next_cancel) = watch::channel(false);
            copy_sftp_stream(
                Box::new(std::io::Cursor::new(b"next upload".to_vec())),
                Box::new(tokio::io::sink()),
                11,
                "test-client",
                "upload",
                "UploadProgress",
                &mut next_cancel,
            )
            .await
            .expect("a later transfer should still succeed");
        });
    }

    #[test]
    fn parses_file_preview_get_head_and_single_ranges() {
        assert_eq!(
            parse_sftp_http_request(
                b"GET /secret/video.mp4 HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=10-19\r\n\r\n",
            )
            .unwrap(),
            SftpHttpRequest {
                head: false,
                path: "/secret/video.mp4".to_owned(),
                range: Some("bytes=10-19".to_owned()),
            },
        );
        assert!(parse_sftp_http_request(b"POST /secret/video.mp4 HTTP/1.1\r\n\r\n").is_err());
        assert_eq!(parse_sftp_http_range(None, 100), Ok((0, 99, false)));
        assert_eq!(
            parse_sftp_http_range(Some("bytes=10-19"), 100),
            Ok((10, 19, true)),
        );
        assert_eq!(
            parse_sftp_http_range(Some("bytes=90-"), 100),
            Ok((90, 99, true)),
        );
        assert_eq!(
            parse_sftp_http_range(Some("bytes=-10"), 100),
            Ok((90, 99, true)),
        );
        assert!(parse_sftp_http_range(Some("bytes=100-"), 100).is_err());
        assert!(parse_sftp_http_range(Some("bytes=0-1,4-5"), 100).is_err());
    }

    #[test]
    fn assigns_inline_media_content_types() {
        assert_eq!(sftp_http_content_type("/tmp/report.PDF"), "application/pdf");
        assert_eq!(sftp_http_content_type("/tmp/movie.mp4"), "video/mp4");
        assert_eq!(sftp_http_content_type("/tmp/audio.flac"), "audio/flac");
        assert_eq!(
            sftp_http_content_type("/tmp/archive.bin"),
            "application/octet-stream",
        );
    }

    #[test]
    fn typed_fast_paths_report_missing_channels_without_json() {
        let shell_error: Value = serde_json::from_str(
            &write_shell_input("missing-shell".to_owned(), "x".to_owned()).unwrap(),
        )
        .unwrap();
        assert_eq!(shell_error["code"], "SESSION_CLOSED");
        assert!(
            write_unix_socket_channel(
                "missing-client".to_owned(),
                "missing-channel".to_owned(),
                vec![1, 2, 3],
            )
            .is_some_and(|error| {
                let error: Value = serde_json::from_str(&error).unwrap();
                error["code"] == "CHANNEL_UNAVAILABLE"
                    && error["message"]
                        .as_str()
                        .unwrap()
                        .contains("Unix-socket channel 'missing-channel' is not open")
            })
        );
        assert!(
            write_length_prefixed_unix_socket_channel(
                "missing-client".to_owned(),
                "missing-channel".to_owned(),
                vec![1, 2, 3],
            )
            .is_some_and(|error| {
                let error: Value = serde_json::from_str(&error).unwrap();
                error["code"] == "CHANNEL_UNAVAILABLE"
                    && error["message"]
                        .as_str()
                        .unwrap()
                        .contains("Unix-socket channel 'missing-channel' is not open")
            })
        );
        assert!(
            write_exec_channel(
                "missing-client".to_owned(),
                "missing-channel".to_owned(),
                vec![1, 2, 3],
            )
            .is_some_and(|error| {
                let error: Value = serde_json::from_str(&error).unwrap();
                error["code"] == "CHANNEL_UNAVAILABLE"
                    && error["message"]
                        .as_str()
                        .unwrap()
                        .contains("exec channel 'missing-channel' is not open")
            })
        );
    }

    #[test]
    fn encodes_supported_frame_length_formats() {
        assert_eq!(LengthFormat::U8.prefix(42).unwrap(), vec![42]);
        assert_eq!(
            LengthFormat::U16Le.prefix(0x1234).unwrap(),
            vec![0x34, 0x12]
        );
        assert_eq!(
            LengthFormat::U16Be.prefix(0x1234).unwrap(),
            vec![0x12, 0x34]
        );
        assert_eq!(
            LengthFormat::U32Le.prefix(0x1234_5678).unwrap(),
            vec![0x78, 0x56, 0x34, 0x12],
        );
        assert_eq!(
            LengthFormat::U32Be.prefix(0x1234_5678).unwrap(),
            vec![0x12, 0x34, 0x56, 0x78],
        );
        assert!(LengthFormat::U8.prefix(256).is_err());
    }

    #[test]
    fn reads_complete_length_prefixed_payloads() {
        runtime().unwrap().block_on(async {
            let mut input = &b"\x03\0\0\0abc\0\0\0\0"[..];
            let mut reader = LengthPrefixedFrameReader::new(LengthFormat::U32Le, 1024);
            assert_eq!(
                reader.read_frame(&mut input).await.unwrap(),
                Some(b"abc".to_vec()),
            );
            assert_eq!(
                reader.read_frame(&mut input).await.unwrap(),
                Some(Vec::new())
            );
            assert_eq!(reader.read_frame(&mut input).await.unwrap(), None);

            let mut oversized = &b"\x04\0\0\0abcd"[..];
            let mut reader = LengthPrefixedFrameReader::new(LengthFormat::U32Le, 3);
            assert!(reader.read_frame(&mut oversized).await.is_err());
        });
    }

    #[test]
    fn preserves_partial_frame_state_when_a_read_is_cancelled() {
        runtime().unwrap().block_on(async {
            let (mut writer, mut input) = tokio::io::duplex(64);
            let mut reader = LengthPrefixedFrameReader::new(LengthFormat::U32Le, 1024);

            writer.write_all(b"\x03\0").await.unwrap();
            assert!(
                tokio::time::timeout(Duration::from_millis(10), reader.read_frame(&mut input),)
                    .await
                    .is_err()
            );

            writer.write_all(b"\0\0abc").await.unwrap();
            assert_eq!(
                reader.read_frame(&mut input).await.unwrap(),
                Some(b"abc".to_vec()),
            );
        });
    }

    #[test]
    fn outbound_writes_continue_when_inbound_delivery_is_backpressured() {
        runtime().unwrap().block_on(async {
            let (socket, mut remote) = tokio::io::duplex(1024);
            let (socket_reader, socket_writer) = tokio::io::split(socket);
            let (delivery_sender, delivery_receiver) = mpsc::channel(1);
            let byte_budget = Arc::new(Semaphore::new(1));
            let held_permit = byte_budget
                .clone()
                .acquire_owned()
                .await
                .expect("test byte budget should be open");
            delivery_sender
                .send(OwnedInboundFrame {
                    bytes: vec![0],
                    _byte_permit: held_permit,
                })
                .await
                .unwrap();

            let read_task = tokio::spawn(read_unix_socket_frames(
                socket_reader,
                Some(LengthFormat::U32Le),
                1024,
                delivery_sender,
                byte_budget,
            ));
            remote.write_all(b"\x03\0\0\0abc").await.unwrap();

            let (control_sender, control_receiver) = mpsc::channel(1);
            let write_task =
                tokio::spawn(write_unix_socket_commands(socket_writer, control_receiver));
            control_sender
                .send(StreamCommand::Write(b"out".to_vec()))
                .await
                .unwrap();
            let mut output = [0; 3];
            tokio::time::timeout(Duration::from_millis(100), remote.read_exact(&mut output))
                .await
                .expect("outbound write must not wait for inbound delivery")
                .unwrap();
            assert_eq!(&output, b"out");

            control_sender.send(StreamCommand::Close).await.unwrap();
            assert_eq!(
                write_task.await.unwrap(),
                ("Unix-socket channel closed by client".to_owned(), true),
            );
            read_task.abort();
            drop(delivery_receiver);
        });
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
            "comment": "russh-test",
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
        let host = std::env::var("RUSSH_SSH_TEST_HOST").expect("missing test host");
        let port = std::env::var("RUSSH_SSH_TEST_PORT")
            .expect("missing test port")
            .parse::<u16>()
            .expect("invalid test port");
        let target_port = std::env::var("RUSSH_SSH_TEST_TARGET_PORT")
            .expect("missing target port")
            .parse::<u16>()
            .expect("invalid target port");
        let username = std::env::var("RUSSH_SSH_TEST_USER").expect("missing test user");
        let private_key = std::fs::read_to_string(
            std::env::var("RUSSH_SSH_TEST_PRIVATE_KEY").expect("missing private key path"),
        )
        .expect("could not read private key");
        let known_hosts = std::fs::read_to_string(
            std::env::var("RUSSH_SSH_TEST_KNOWN_HOSTS").expect("missing known_hosts path"),
        )
        .expect("could not read known_hosts");
        let shared = std::path::PathBuf::from(
            std::env::var("RUSSH_SSH_TEST_SHARED_DIR").expect("missing shared directory"),
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
                json!({"key": "live-main", "command": "printf russh-live"}),
            )
            .await;
            assert_eq!(executed["stdout"], "russh-live");

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
                "sftpCreateDirAll",
                json!({"key": "live-main", "path": "/workspace/remote/nested"}),
            )
            .await;
            live_call(
                "sftpCreateDirAll",
                json!({"key": "live-main", "path": "/workspace/remote/nested"}),
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
                    "remotePath": "/workspace/remote/nested",
                }),
            )
            .await;
            let mkdir_collision = dispatch(Request {
                operation: "sftpCreateDirAll".to_owned(),
                params: json!({
                    "key": "live-main",
                    "path": "/workspace/remote/nested/payload.txt/child",
                }),
            })
            .await
            .unwrap_err();
            assert!(mkdir_collision.to_string().contains("is not a directory"));
            fs::write(&payload, b"sftp-live-replacement").await.unwrap();
            live_call(
                "sftpUploadToPath",
                json!({
                    "key": "live-main",
                    "localPath": payload,
                    "remotePath": "/workspace/remote/nested/generated-name.txt",
                }),
            )
            .await;
            live_call(
                "sftpUploadToPath",
                json!({
                    "key": "live-main",
                    "localPath": payload,
                    "remotePath": "/workspace/remote/nested/generated-name.txt",
                }),
            )
            .await;
            live_call(
                "sftpChmod",
                json!({"key": "live-main", "path": "/workspace/remote/nested/generated-name.txt", "permissions": 0o640}),
            )
            .await;
            live_call(
                "sftpRename",
                json!({
                    "key": "live-main",
                    "oldPath": "/workspace/remote/nested/generated-name.txt",
                    "newPath": "/workspace/remote/nested/renamed.txt",
                }),
            )
            .await;
            let entries = live_call(
                "sftpLs",
                json!({"key": "live-main", "path": "/workspace/remote/nested"}),
            )
            .await;
            assert!(entries.as_array().unwrap().iter().any(|entry| {
                entry["filename"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("renamed.txt")
            }));
            assert!(!entries.as_array().unwrap().iter().any(|entry| {
                let filename = entry["filename"].as_str().unwrap_or_default();
                filename.contains("russh-part") || filename.contains("russh-backup")
            }));
            let downloaded = live_call(
                "sftpDownload",
                json!({
                    "key": "live-main",
                    "remotePath": "/workspace/remote/nested/renamed.txt",
                    "localPath": download_dir,
                }),
            )
            .await;
            assert_eq!(
                fs::read(downloaded.as_str().unwrap()).await.unwrap(),
                b"sftp-live-replacement"
            );

            let file_server = live_call(
                "startSftpFileServer",
                json!({
                    "key": "live-main",
                    "remotePath": "/workspace/remote/nested/renamed.txt",
                }),
            )
            .await;
            let file_server_port = file_server["localPort"].as_u64().unwrap() as u16;
            let file_server_token = file_server["token"].as_str().unwrap();
            let mut preview = tokio::net::TcpStream::connect(("127.0.0.1", file_server_port))
                .await
                .unwrap();
            preview
                .write_all(
                    format!(
                        "GET /{file_server_token}/renamed.txt HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=10-20\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            let mut preview_response = Vec::new();
            preview.read_to_end(&mut preview_response).await.unwrap();
            let preview_response = String::from_utf8(preview_response).unwrap();
            assert!(preview_response.starts_with("HTTP/1.1 206 Partial Content\r\n"));
            assert!(preview_response.contains("Content-Range: bytes 10-20/21\r\n"));
            assert!(preview_response.ends_with("replacement"));
            live_call(
                "closeSftpFileServer",
                json!({"key": "live-main", "localPort": file_server_port}),
            )
            .await;

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
            let transfer_error = tokio::time::timeout(Duration::from_secs(1), transfer)
                .await
                .expect("cancelled upload should settle promptly")
                .unwrap()
                .unwrap_err()
                .to_string();
            assert!(transfer_error.contains("cancelled"));
            let entries = live_call(
                "sftpLs",
                json!({"key": "live-main", "path": "/workspace/remote"}),
            )
            .await;
            assert!(!entries.as_array().unwrap().iter().any(|entry| {
                let filename = entry["filename"].as_str().unwrap_or_default();
                filename == "cancel.bin" || filename.contains("russh-part")
            }));
            live_call(
                "sftpUploadToPath",
                json!({
                    "key": "live-main",
                    "localPath": payload,
                    "remotePath": "/workspace/remote/after-cancel.txt",
                }),
            )
            .await;
            let entries = live_call(
                "sftpLs",
                json!({"key": "live-main", "path": "/workspace/remote"}),
            )
            .await;
            assert!(entries.as_array().unwrap().iter().any(|entry| {
                entry["filename"].as_str() == Some("after-cancel.txt")
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
                    "credential": {"type": "password", "password": "russh-test-password"},
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
