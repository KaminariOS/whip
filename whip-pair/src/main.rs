mod authorized_keys;
mod network;
mod protocol;

use std::{
    io::{self, IsTerminal, Write},
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    process::Command,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use clap::{Parser, Subcommand};
use qrcode::{EcLevel, QrCode, render::unicode};
use rand::{RngCore, rngs::OsRng};
use rcgen::generate_simple_self_signed;
use rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, ServerConfig, SignatureScheme,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{WebPkiSupportedAlgorithms, verify_tls12_signature, verify_tls13_signature},
    pki_types::{CertificateDer, PrivatePkcs8KeyDer, ServerName},
};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    time::{Instant, timeout, timeout_at},
};
use tokio_rustls::{TlsAcceptor, TlsConnector};

use crate::{
    authorized_keys::{AppendOutcome, append_authorized_key, default_authorized_keys_path},
    network::{BindCandidate, discover_bind_candidates, select_bind_candidate},
    protocol::{
        EnrollmentRequest, EnrollmentResponse, PairingHello, PairingPayload, PairingServerInfo,
        decode_pairing_code, encode_pairing_code, fingerprint_public_key, validate_public_key,
    },
};

const DEFAULT_TTL_SECONDS: u64 = 120;
const DEFAULT_SSH_PORT: u16 = 22;
const DEFAULT_PAIRING_PORT: u16 = 8765;
const MAX_MESSAGE_BYTES: usize = 16 * 1024;
const UNAUTHENTICATED_CONNECTION_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Bind a one-shot pairing server and display its QR code.
    Serve(ServeArgs),
    /// Development client: submit a public key using a copied pairing code.
    Request(RequestArgs),
    /// Decode and print a copied pairing code.
    Inspect { code: String },
}

#[derive(Debug, clap::Args)]
struct ServeArgs {
    /// Interface address to bind. Without this, an interactive selector is shown.
    #[arg(long)]
    bind: Option<IpAddr>,
    /// Pairing port. Use zero to ask the OS for an available port.
    #[arg(long, default_value_t = DEFAULT_PAIRING_PORT)]
    port: u16,
    /// Hostname or address Whip should use for the pairing connection.
    #[arg(long)]
    advertise_host: Option<String>,
    /// Hostname or address Whip should save for SSH.
    #[arg(long)]
    ssh_host: Option<String>,
    #[arg(long, default_value_t = DEFAULT_SSH_PORT)]
    ssh_port: u16,
    #[arg(long)]
    ssh_user: Option<String>,
    /// Override SSH host-key discovery (primarily useful for prototypes/tests).
    #[arg(long)]
    ssh_fingerprint: Option<String>,
    #[arg(long, default_value_t = DEFAULT_TTL_SECONDS)]
    ttl: u64,
    #[arg(long)]
    authorized_keys: Option<PathBuf>,
    /// Skip the terminal approval prompt. Intended only for automated tests.
    #[arg(long, hide = true)]
    yes: bool,
    /// Print the pairing envelope as text in addition to the QR.
    #[arg(long)]
    print_code: bool,
    /// Write the pairing envelope to a new mode-0600 file. Intended for tests.
    #[arg(long, hide = true)]
    code_output: Option<PathBuf>,
}

#[derive(Debug, clap::Args)]
struct RequestArgs {
    /// Pairing envelope copied from the host.
    #[arg(long)]
    code: String,
    /// OpenSSH public-key file to enroll.
    #[arg(long)]
    public_key: PathBuf,
    #[arg(long, default_value = "Whip prototype")]
    device_name: String,
}

#[derive(Debug, thiserror::Error)]
enum Error {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Protocol(#[from] protocol::ProtocolError),
    #[error("TLS error: {0}")]
    Tls(#[from] rustls::Error),
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Error> {
    let cli = Cli::parse();
    match cli.command.unwrap_or(Commands::Serve(ServeArgs {
        bind: None,
        port: DEFAULT_PAIRING_PORT,
        advertise_host: None,
        ssh_host: None,
        ssh_port: DEFAULT_SSH_PORT,
        ssh_user: None,
        ssh_fingerprint: None,
        ttl: DEFAULT_TTL_SECONDS,
        authorized_keys: None,
        yes: false,
        print_code: false,
        code_output: None,
    })) {
        Commands::Serve(args) => serve(args).await,
        Commands::Request(args) => request(args).await,
        Commands::Inspect { code } => {
            let payload = decode_pairing_code(&code)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "version": 3,
                    "pair_host": payload.pair_host,
                    "pair_port": payload.pair_port,
                    "token": "<redacted>",
                    "tls_certificate_sha256": URL_SAFE_NO_PAD
                        .encode(payload.tls_certificate_sha256),
                }))?
            );
            Ok(())
        }
    }
}

async fn serve(args: ServeArgs) -> Result<(), Error> {
    if args.ttl == 0 || args.ttl > 600 {
        return Err(Error::Message(
            "--ttl must be between 1 and 600 seconds".into(),
        ));
    }
    if !args.yes && !io::stdin().is_terminal() {
        return Err(Error::Message(
            "pairing approval requires a terminal; run whip-pair interactively".into(),
        ));
    }

    let selected = choose_bind_candidate(args.bind)?;
    let listener = TcpListener::bind(SocketAddr::new(selected.address, args.port)).await?;
    let bound = listener.local_addr()?;
    let pair_host = args
        .advertise_host
        .unwrap_or_else(|| selected.address.to_string());
    server_name(&pair_host)?;
    let ssh_host = args.ssh_host.unwrap_or_else(|| pair_host.clone());
    let ssh_user = args.ssh_user.unwrap_or_else(current_username);
    let ssh_fingerprint = match args.ssh_fingerprint {
        Some(value) => validate_ssh_fingerprint(&value)?,
        None => discover_ssh_fingerprint(&ssh_host, args.ssh_port)?,
    };

    let certified = generate_simple_self_signed(vec![pair_host.clone()]).map_err(|error| {
        Error::Message(format!("could not generate pairing certificate: {error}"))
    })?;
    let certificate = certified.cert.der().clone();
    let private_key = PrivatePkcs8KeyDer::from(certified.key_pair.serialize_der());
    let server_config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![certificate.clone()], private_key.into())?;
    let acceptor = TlsAcceptor::from(Arc::new(server_config));

    let mut token = [0_u8; 16];
    OsRng.fill_bytes(&mut token);
    let now = unix_seconds()?;
    let server_info = PairingServerInfo {
        ssh_host,
        ssh_port: args.ssh_port,
        ssh_user,
        ssh_host_fingerprint: ssh_fingerprint,
    };
    let expires_at = now + args.ttl;
    validate_server_info(&server_info)?;
    let payload = PairingPayload {
        pair_host,
        pair_port: bound.port(),
        token,
        tls_certificate_sha256: Sha256::digest(certificate.as_ref()).into(),
    };
    let code = encode_pairing_code(&payload)?;
    if let Some(path) = args.code_output.as_deref() {
        write_secret_file(path, &code)?;
    }
    print_pairing_screen(&selected, &server_info, expires_at, &code, args.print_code)?;

    let deadline = Instant::now() + Duration::from_secs(args.ttl);
    let connection_context = ConnectionContext {
        acceptor: &acceptor,
        payload: &payload,
        server_info: &server_info,
        authorized_keys_override: args.authorized_keys.as_deref(),
        assume_yes: args.yes,
        expires_at,
        deadline,
    };
    loop {
        let (stream, peer) = match timeout_at(deadline, listener.accept()).await {
            Ok(result) => result?,
            Err(_) => return Err(Error::Message("pairing code expired".into())),
        };

        match handle_connection(stream, peer, &connection_context).await {
            Ok(ConnectionOutcome::Enrolled) => return Ok(()),
            Ok(ConnectionOutcome::Ignored) => continue,
            Err(error) => {
                eprintln!("ignored pairing connection from {peer}: {error}");
            }
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
enum ConnectionOutcome {
    Enrolled,
    Ignored,
}

struct ConnectionContext<'a> {
    acceptor: &'a TlsAcceptor,
    payload: &'a PairingPayload,
    server_info: &'a PairingServerInfo,
    authorized_keys_override: Option<&'a std::path::Path>,
    assume_yes: bool,
    expires_at: u64,
    deadline: Instant,
}

async fn handle_connection(
    stream: TcpStream,
    peer: SocketAddr,
    context: &ConnectionContext<'_>,
) -> Result<ConnectionOutcome, Error> {
    let request_deadline = std::cmp::min(
        context.deadline,
        Instant::now() + UNAUTHENTICATED_CONNECTION_TIMEOUT,
    );
    let tls = match timeout_at(request_deadline, context.acceptor.accept(stream)).await {
        Ok(Ok(tls)) => tls,
        Ok(Err(error)) => return Err(Error::Message(format!("TLS handshake failed: {error}"))),
        Err(_) => return Err(Error::Message("pairing code expired".into())),
    };
    let (reader, mut writer) = tokio::io::split(tls);
    let mut reader = BufReader::new(reader);
    let mut bytes = Vec::new();
    let read = timeout_at(request_deadline, reader.read_until(b'\n', &mut bytes))
        .await
        .map_err(|_| Error::Message("pairing request timed out".into()))??;
    if read == 0 || bytes.len() > MAX_MESSAGE_BYTES || bytes.last() != Some(&b'\n') {
        send_response(
            &mut writer,
            &EnrollmentResponse::error("invalid_request", "expected one bounded JSON line"),
        )
        .await?;
        return Ok(ConnectionOutcome::Ignored);
    }

    let hello: PairingHello = match serde_json::from_slice(&bytes[..bytes.len() - 1]) {
        Ok(hello) => hello,
        Err(_) => {
            send_response(
                &mut writer,
                &EnrollmentResponse::error("invalid_request", "pairing hello is not valid JSON"),
            )
            .await?;
            return Ok(ConnectionOutcome::Ignored);
        }
    };
    if !matches!(decode_token(&hello.token), Ok(token) if token == context.payload.token) {
        send_response(
            &mut writer,
            &EnrollmentResponse::error("unauthorized", "pairing token did not match"),
        )
        .await?;
        return Ok(ConnectionOutcome::Ignored);
    }
    if unix_seconds()? > context.expires_at {
        send_response(
            &mut writer,
            &EnrollmentResponse::error("expired", "pairing code expired"),
        )
        .await?;
        return Ok(ConnectionOutcome::Ignored);
    }
    send_json_line(&mut writer, context.server_info).await?;

    bytes.clear();
    let read = timeout_at(request_deadline, reader.read_until(b'\n', &mut bytes))
        .await
        .map_err(|_| Error::Message("pairing request timed out".into()))??;
    if read == 0 || bytes.len() > MAX_MESSAGE_BYTES || bytes.last() != Some(&b'\n') {
        send_response(
            &mut writer,
            &EnrollmentResponse::error("invalid_request", "expected one bounded JSON line"),
        )
        .await?;
        return Ok(ConnectionOutcome::Ignored);
    }
    let request: EnrollmentRequest = match serde_json::from_slice(&bytes[..bytes.len() - 1]) {
        Ok(request) => request,
        Err(_) => {
            send_response(
                &mut writer,
                &EnrollmentResponse::error("invalid_request", "request is not valid JSON"),
            )
            .await?;
            return Ok(ConnectionOutcome::Ignored);
        }
    };

    let public_key = match validate_public_key(&request.public_key) {
        Ok(key) => key,
        Err(error) => {
            send_response(
                &mut writer,
                &EnrollmentResponse::error("invalid_key", &error.to_string()),
            )
            .await?;
            return Ok(ConnectionOutcome::Ignored);
        }
    };
    let fingerprint = fingerprint_public_key(&public_key);
    let device_name = printable_device_name(&request.device_name);
    println!("\n{} ({peer}) wants SSH access.", device_name);
    println!("Key: {fingerprint}");

    let approved = if context.assume_yes {
        true
    } else {
        tokio::task::spawn_blocking(confirm_enrollment)
            .await
            .map_err(|error| Error::Message(format!("approval task failed: {error}")))??
    };
    if !approved {
        send_response(
            &mut writer,
            &EnrollmentResponse::error("rejected", "the host user rejected enrollment"),
        )
        .await?;
        println!("Enrollment rejected.");
        return Ok(ConnectionOutcome::Ignored);
    }
    if unix_seconds()? > context.expires_at {
        send_response(
            &mut writer,
            &EnrollmentResponse::error("expired", "pairing code expired"),
        )
        .await?;
        return Ok(ConnectionOutcome::Ignored);
    }

    let path = context
        .authorized_keys_override
        .map(PathBuf::from)
        .unwrap_or(default_authorized_keys_path()?);
    let key_line = public_key.canonical_line(request.public_key.trim());
    let outcome = append_authorized_key(&path, &key_line)?;
    send_response(
        &mut writer,
        &EnrollmentResponse::approved(&fingerprint, outcome == AppendOutcome::AlreadyPresent),
    )
    .await?;
    println!(
        "{} {}",
        if outcome == AppendOutcome::Added {
            "Added key to"
        } else {
            "Key already present in"
        },
        path.display()
    );
    println!("Pairing server stopped.");
    Ok(ConnectionOutcome::Enrolled)
}

async fn send_response<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    response: &EnrollmentResponse,
) -> Result<(), Error> {
    send_json_line(writer, response).await?;
    writer.shutdown().await?;
    Ok(())
}

async fn send_json_line<W, T>(writer: &mut W, value: &T) -> Result<(), Error>
where
    W: AsyncWriteExt + Unpin,
    T: serde::Serialize,
{
    let mut encoded = serde_json::to_vec(value)?;
    encoded.push(b'\n');
    writer.write_all(&encoded).await?;
    Ok(())
}

async fn request(args: RequestArgs) -> Result<(), Error> {
    let payload = decode_pairing_code(&args.code)?;
    let public_key_text = std::fs::read_to_string(&args.public_key)?;
    let public_key = validate_public_key(&public_key_text)?;

    let verifier = PinnedCertificateVerifier::new(payload.tls_certificate_sha256);
    let client_config = ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    let connector = TlsConnector::from(Arc::new(client_config));
    let server_name = server_name(&payload.pair_host)?;
    let tcp = timeout(
        Duration::from_secs(5),
        TcpStream::connect((payload.pair_host.as_str(), payload.pair_port)),
    )
    .await
    .map_err(|_| Error::Message("pairing server connection timed out".into()))??;
    let tls = connector
        .connect(server_name, tcp)
        .await
        .map_err(|error| Error::Message(format!("pairing TLS verification failed: {error}")))?;
    let (reader, mut writer) = tokio::io::split(tls);
    send_json_line(
        &mut writer,
        &PairingHello {
            token: URL_SAFE_NO_PAD.encode(payload.token),
        },
    )
    .await?;

    let mut reader = BufReader::new(reader);
    let mut server_info_bytes = Vec::new();
    let read = timeout(
        Duration::from_secs(5),
        reader.read_until(b'\n', &mut server_info_bytes),
    )
    .await
    .map_err(|_| Error::Message("pairing server information timed out".into()))??;
    if read == 0
        || server_info_bytes.last() != Some(&b'\n')
        || server_info_bytes.len() > MAX_MESSAGE_BYTES
    {
        return Err(Error::Message(
            "pairing server returned invalid connection information".into(),
        ));
    }
    let server_info: PairingServerInfo =
        serde_json::from_slice(&server_info_bytes[..server_info_bytes.len() - 1])?;
    validate_server_info(&server_info)?;
    let request = EnrollmentRequest {
        device_name: args.device_name,
        public_key: public_key.canonical_line(public_key_text.trim()),
    };
    send_json_line(&mut writer, &request).await?;

    let mut response = Vec::new();
    let read = timeout(
        Duration::from_secs(600),
        reader.read_until(b'\n', &mut response),
    )
    .await
    .map_err(|_| Error::Message("host approval timed out".into()))??;
    if read == 0 || response.last() != Some(&b'\n') || response.len() > MAX_MESSAGE_BYTES {
        return Err(Error::Message(
            "pairing server returned an invalid response".into(),
        ));
    }
    let response: EnrollmentResponse = serde_json::from_slice(&response[..response.len() - 1])?;
    if response.approved {
        println!(
            "Enrollment approved: {}",
            response
                .fingerprint
                .as_deref()
                .unwrap_or("unknown fingerprint")
        );
        println!(
            "SSH profile: {}@{}:{}",
            server_info.ssh_user, server_info.ssh_host, server_info.ssh_port
        );
        Ok(())
    } else {
        Err(Error::Message(format!(
            "enrollment refused ({}): {}",
            response.code.as_deref().unwrap_or("unknown"),
            response.message.as_deref().unwrap_or("no detail")
        )))
    }
}

#[derive(Debug)]
struct PinnedCertificateVerifier {
    expected_sha256: [u8; 32],
    supported_algorithms: WebPkiSupportedAlgorithms,
}

impl PinnedCertificateVerifier {
    fn new(expected_sha256: [u8; 32]) -> Self {
        Self {
            expected_sha256,
            supported_algorithms: rustls::crypto::ring::default_provider()
                .signature_verification_algorithms,
        }
    }
}

impl ServerCertVerifier for PinnedCertificateVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        // The QR is the trust root for this short-lived connection. The exact
        // certificate still has to prove possession of its private key in the
        // TLS handshake; the signature methods below retain that verification.
        let actual_sha256: [u8; 32] = Sha256::digest(end_entity.as_ref()).into();
        if actual_sha256 != self.expected_sha256 {
            return Err(CertificateError::ApplicationVerificationFailure.into());
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.supported_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.supported_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.supported_algorithms.supported_schemes()
    }
}

fn choose_bind_candidate(explicit: Option<IpAddr>) -> Result<BindCandidate, Error> {
    if let Some(address) = explicit {
        return Ok(BindCandidate {
            interface: "explicit".into(),
            address,
            label: "Selected address".into(),
        });
    }
    let candidates = discover_bind_candidates()?;
    select_bind_candidate(&candidates).map_err(Error::Message)
}

fn print_pairing_screen(
    selected: &BindCandidate,
    server_info: &PairingServerInfo,
    expires_at: u64,
    code: &str,
    print_code: bool,
) -> Result<(), Error> {
    let qr = QrCode::with_error_correction_level(code.as_bytes(), EcLevel::L)
        .map_err(|error| Error::Message(format!("could not encode pairing QR: {error}")))?;
    let rendered = qr
        .render::<unicode::Dense1x2>()
        .dark_color(unicode::Dense1x2::Dark)
        .light_color(unicode::Dense1x2::Light)
        .quiet_zone(true)
        .build();
    println!("\nWhip Pair\n");
    println!(
        "Network: {} ({}, {})",
        selected.label, selected.interface, selected.address
    );
    println!(
        "SSH:     {}@{}:{}",
        server_info.ssh_user, server_info.ssh_host, server_info.ssh_port
    );
    println!(
        "Expires: {} seconds\n",
        expires_at.saturating_sub(unix_seconds()?)
    );
    println!("{rendered}");
    println!("Scan with Whip. Press Ctrl-C to cancel.");
    if print_code {
        println!("\n{code}");
    }
    io::stdout().flush()?;
    Ok(())
}

fn confirm_enrollment() -> Result<bool, io::Error> {
    print!("Allow this device? [y/N] ");
    io::stdout().flush()?;
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    Ok(matches!(
        answer.trim().to_ascii_lowercase().as_str(),
        "y" | "yes"
    ))
}

fn discover_ssh_fingerprint(host: &str, port: u16) -> Result<String, Error> {
    let output = Command::new("ssh-keyscan")
        .args(["-T", "3", "-t", "ed25519", "-p", &port.to_string(), host])
        .output()
        .map_err(|error| Error::Message(format!("could not run ssh-keyscan: {error}")))?;
    if !output.status.success() && output.stdout.is_empty() {
        return Err(Error::Message(format!(
            "could not discover the SSH host key for {host}:{port}; ensure sshd is running or pass --ssh-fingerprint"
        )));
    }
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut fields = line.split_whitespace();
        let _host = fields.next();
        let kind = fields.next();
        let blob = fields.next();
        if kind == Some("ssh-ed25519")
            && let Some(blob) = blob
        {
            let public_key = validate_public_key(&format!("ssh-ed25519 {blob}"))?;
            return Ok(fingerprint_public_key(&public_key));
        }
    }
    Err(Error::Message(format!(
        "{host}:{port} did not present an Ed25519 SSH host key"
    )))
}

fn validate_ssh_fingerprint(value: &str) -> Result<String, Error> {
    let Some(encoded) = value.strip_prefix("SHA256:") else {
        return Err(Error::Message(
            "SSH fingerprint must start with SHA256:".into(),
        ));
    };
    if encoded.len() != 43
        || !encoded
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
    {
        return Err(Error::Message(
            "SSH fingerprint must be an OpenSSH SHA256 fingerprint".into(),
        ));
    }
    Ok(value.to_owned())
}

fn validate_server_info(info: &PairingServerInfo) -> Result<(), Error> {
    if info.ssh_host.is_empty()
        || info.ssh_user.is_empty()
        || info.ssh_port == 0
        || info
            .ssh_host
            .chars()
            .chain(info.ssh_user.chars())
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(Error::Message(
            "pairing server returned an invalid SSH profile".into(),
        ));
    }
    validate_ssh_fingerprint(&info.ssh_host_fingerprint)?;
    Ok(())
}

fn decode_token(encoded: &str) -> Result<[u8; 16], Error> {
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| Error::Message("pairing token is not valid base64url".into()))?;
    decoded
        .try_into()
        .map_err(|_| Error::Message("pairing token has the wrong length".into()))
}

fn server_name(host: &str) -> Result<ServerName<'static>, Error> {
    if let Ok(address) = host.parse::<IpAddr>() {
        return Ok(ServerName::IpAddress(address.into()));
    }
    ServerName::try_from(host.to_owned())
        .map_err(|_| Error::Message(format!("invalid pairing hostname: {host}")))
}

fn current_username() -> String {
    std::env::var("USER")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "unknown".into())
}

fn unix_seconds() -> Result<u64, Error> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| Error::Message("system clock is before the Unix epoch".into()))
}

fn printable_device_name(value: &str) -> String {
    let filtered: String = value
        .chars()
        .filter(|character| !character.is_control())
        .take(80)
        .collect();
    if filtered.trim().is_empty() {
        "Unknown device".into()
    } else {
        filtered
    }
}

fn write_secret_file(path: &std::path::Path, value: &str) -> Result<(), Error> {
    use std::fs::OpenOptions;
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(value.as_bytes())?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}
