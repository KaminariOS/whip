use std::{net::IpAddr, sync::Arc, time::Duration};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, SignatureScheme,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{WebPkiSupportedAlgorithms, verify_tls12_signature, verify_tls13_signature},
    pki_types::{CertificateDer, ServerName},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
    time::timeout,
};
use tokio_rustls::TlsConnector;

const ENVELOPE_PREFIX: &str = "WP3:";
const BASE45_ALPHABET: &[u8; 45] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const ADDRESS_IPV4: u8 = 1;
const ADDRESS_IPV6: u8 = 2;
const ADDRESS_HOSTNAME: u8 = 3;
const MAX_HOSTNAME_BYTES: usize = 253;
const MAX_BASE45_BYTES: usize = 461;
const MAX_MESSAGE_BYTES: usize = 16 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum PairingError {
    #[error("pairing code has the wrong prefix or version")]
    BadPrefix,
    #[error("pairing code is not valid Base45")]
    BadEncoding,
    #[error("pairing code contains an invalid host or port")]
    BadPayload,
    #[error("invalid pairing hostname: {0}")]
    BadHostname(String),
    #[error("pairing server connection timed out")]
    ConnectionTimeout,
    #[error("pairing server information timed out")]
    ServerInfoTimeout,
    #[error("host approval timed out")]
    ApprovalTimeout,
    #[error("pairing TLS verification failed: {0}")]
    Tls(String),
    #[error("pairing server returned invalid data")]
    InvalidResponse,
    #[error("pairing server returned an invalid SSH profile")]
    InvalidSshProfile,
    #[error("enrollment refused ({code}): {message}")]
    Refused { code: String, message: String },
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct PairingPayload {
    pair_host: String,
    pair_port: u16,
    token: [u8; 16],
    tls_certificate_sha256: [u8; 32],
}

#[derive(Serialize)]
struct PairingHello {
    token: String,
}

#[derive(Deserialize)]
struct PairingServerInfo {
    ssh_host: String,
    ssh_port: u16,
    ssh_user: String,
    ssh_host_fingerprint: String,
}

#[derive(Serialize)]
struct EnrollmentRequest<'a> {
    device_name: &'a str,
    public_key: &'a str,
}

#[derive(Deserialize)]
struct EnrollmentResponse {
    approved: bool,
    fingerprint: Option<String>,
    already_present: Option<bool>,
    code: Option<String>,
    message: Option<String>,
}

pub async fn pair_host(
    code: &str,
    public_key: &str,
    device_name: &str,
) -> Result<Value, PairingError> {
    let payload = decode_pairing_code(code.trim())?;
    let public_key = public_key.trim();
    if public_key.is_empty() || public_key.len() > 4096 || public_key.chars().any(char::is_control)
    {
        return Err(PairingError::InvalidResponse);
    }

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
    .map_err(|_| PairingError::ConnectionTimeout)??;
    let tls = connector
        .connect(server_name, tcp)
        .await
        .map_err(|error| PairingError::Tls(error.to_string()))?;
    let (reader, mut writer) = tokio::io::split(tls);

    send_json_line(
        &mut writer,
        &PairingHello {
            token: URL_SAFE_NO_PAD.encode(payload.token),
        },
    )
    .await?;

    let mut reader = BufReader::new(reader);
    let server_info_bytes = timeout(Duration::from_secs(5), read_bounded_line(&mut reader))
        .await
        .map_err(|_| PairingError::ServerInfoTimeout)??;
    let server_info: PairingServerInfo = serde_json::from_slice(&server_info_bytes)?;
    validate_server_info(&server_info)?;

    let device_name = printable_device_name(device_name);
    send_json_line(
        &mut writer,
        &EnrollmentRequest {
            device_name: &device_name,
            public_key,
        },
    )
    .await?;

    let response_bytes = timeout(Duration::from_secs(600), read_bounded_line(&mut reader))
        .await
        .map_err(|_| PairingError::ApprovalTimeout)??;
    let response: EnrollmentResponse = serde_json::from_slice(&response_bytes)?;
    if !response.approved {
        return Err(PairingError::Refused {
            code: response.code.unwrap_or_else(|| "unknown".into()),
            message: response.message.unwrap_or_else(|| "no detail".into()),
        });
    }

    Ok(json!({
        "sshHost": server_info.ssh_host,
        "sshPort": server_info.ssh_port,
        "sshUser": server_info.ssh_user,
        "sshHostFingerprint": server_info.ssh_host_fingerprint,
        "keyFingerprint": response.fingerprint,
        "alreadyPresent": response.already_present.unwrap_or(false),
    }))
}

async fn send_json_line<T: Serialize>(
    writer: &mut (impl AsyncWriteExt + Unpin),
    value: &T,
) -> Result<(), PairingError> {
    let mut encoded = serde_json::to_vec(value)?;
    encoded.push(b'\n');
    writer.write_all(&encoded).await?;
    Ok(())
}

async fn read_bounded_line<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
) -> Result<Vec<u8>, PairingError> {
    let mut bytes = Vec::new();
    let read = reader
        .take((MAX_MESSAGE_BYTES + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .await?;
    if read == 0 || bytes.last() != Some(&b'\n') || bytes.len() > MAX_MESSAGE_BYTES {
        return Err(PairingError::InvalidResponse);
    }
    bytes.pop();
    Ok(bytes)
}

fn validate_server_info(info: &PairingServerInfo) -> Result<(), PairingError> {
    if info.ssh_host.is_empty()
        || info.ssh_user.is_empty()
        || info.ssh_port == 0
        || info
            .ssh_host
            .chars()
            .chain(info.ssh_user.chars())
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(PairingError::InvalidSshProfile);
    }
    let Some(encoded) = info.ssh_host_fingerprint.strip_prefix("SHA256:") else {
        return Err(PairingError::InvalidSshProfile);
    };
    if encoded.len() != 43
        || !encoded
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
    {
        return Err(PairingError::InvalidSshProfile);
    }
    Ok(())
}

fn printable_device_name(value: &str) -> String {
    let value: String = value
        .chars()
        .filter(|character| !character.is_control())
        .take(80)
        .collect();
    if value.trim().is_empty() {
        "Whip".into()
    } else {
        value
    }
}

fn server_name(host: &str) -> Result<ServerName<'static>, PairingError> {
    if let Ok(address) = host.parse::<IpAddr>() {
        return Ok(ServerName::IpAddress(address.into()));
    }
    ServerName::try_from(host.to_owned()).map_err(|_| PairingError::BadHostname(host.into()))
}

fn decode_pairing_code(code: &str) -> Result<PairingPayload, PairingError> {
    let body = code
        .strip_prefix(ENVELOPE_PREFIX)
        .ok_or(PairingError::BadPrefix)?;
    let decoded = base45_decode(body)?;
    let mut cursor = 0;
    let address_type = take_bytes(&decoded, &mut cursor, 1)?[0];
    let pair_host = match address_type {
        ADDRESS_IPV4 => {
            let octets: [u8; 4] = take_bytes(&decoded, &mut cursor, 4)?
                .try_into()
                .map_err(|_| PairingError::BadEncoding)?;
            IpAddr::from(octets).to_string()
        }
        ADDRESS_IPV6 => {
            let octets: [u8; 16] = take_bytes(&decoded, &mut cursor, 16)?
                .try_into()
                .map_err(|_| PairingError::BadEncoding)?;
            IpAddr::from(octets).to_string()
        }
        ADDRESS_HOSTNAME => {
            let length = usize::from(take_bytes(&decoded, &mut cursor, 1)?[0]);
            String::from_utf8(take_bytes(&decoded, &mut cursor, length)?.to_vec())
                .map_err(|_| PairingError::BadEncoding)?
        }
        _ => return Err(PairingError::BadEncoding),
    };
    let pair_port = u16::from_be_bytes(
        take_bytes(&decoded, &mut cursor, 2)?
            .try_into()
            .map_err(|_| PairingError::BadEncoding)?,
    );
    let token = take_bytes(&decoded, &mut cursor, 16)?
        .try_into()
        .map_err(|_| PairingError::BadEncoding)?;
    let tls_certificate_sha256 = take_bytes(&decoded, &mut cursor, 32)?
        .try_into()
        .map_err(|_| PairingError::BadEncoding)?;
    if cursor != decoded.len()
        || pair_host.is_empty()
        || pair_host.len() > MAX_HOSTNAME_BYTES
        || pair_port == 0
        || !pair_host.is_ascii()
        || pair_host
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(PairingError::BadPayload);
    }
    Ok(PairingPayload {
        pair_host,
        pair_port,
        token,
        tls_certificate_sha256,
    })
}

fn take_bytes<'a>(
    bytes: &'a [u8],
    cursor: &mut usize,
    length: usize,
) -> Result<&'a [u8], PairingError> {
    let end = cursor
        .checked_add(length)
        .ok_or(PairingError::BadEncoding)?;
    let value = bytes.get(*cursor..end).ok_or(PairingError::BadEncoding)?;
    *cursor = end;
    Ok(value)
}

fn base45_decode(encoded: &str) -> Result<Vec<u8>, PairingError> {
    if encoded.is_empty()
        || encoded.len() > MAX_BASE45_BYTES
        || encoded.len() % 3 == 1
        || !encoded.is_ascii()
    {
        return Err(PairingError::BadEncoding);
    }
    let mut decoded = Vec::with_capacity(encoded.len() * 2 / 3);
    for chunk in encoded.as_bytes().chunks(3) {
        let mut value = base45_value(chunk[0])? + 45 * base45_value(chunk[1])?;
        if chunk.len() == 3 {
            value += 45 * 45 * base45_value(chunk[2])?;
            if value > u16::MAX.into() {
                return Err(PairingError::BadEncoding);
            }
            decoded.extend_from_slice(&(value as u16).to_be_bytes());
        } else {
            if value > u8::MAX.into() {
                return Err(PairingError::BadEncoding);
            }
            decoded.push(value as u8);
        }
    }
    Ok(decoded)
}

fn base45_value(byte: u8) -> Result<usize, PairingError> {
    BASE45_ALPHABET
        .iter()
        .position(|candidate| *candidate == byte)
        .ok_or(PairingError::BadEncoding)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn base45_encode(bytes: &[u8]) -> String {
        let mut encoded = String::new();
        for chunk in bytes.chunks(2) {
            let value = if chunk.len() == 2 {
                usize::from(chunk[0]) * 256 + usize::from(chunk[1])
            } else {
                usize::from(chunk[0])
            };
            encoded.push(char::from(BASE45_ALPHABET[value % 45]));
            encoded.push(char::from(BASE45_ALPHABET[(value / 45) % 45]));
            if chunk.len() == 2 {
                encoded.push(char::from(BASE45_ALPHABET[value / (45 * 45)]));
            }
        }
        encoded
    }

    #[test]
    fn decodes_v3_ipv4_payload() {
        let mut bytes = vec![ADDRESS_IPV4, 192, 168, 1, 7];
        bytes.extend_from_slice(&43123_u16.to_be_bytes());
        bytes.extend_from_slice(&[7; 16]);
        bytes.extend_from_slice(&[9; 32]);
        let code = format!("{ENVELOPE_PREFIX}{}", base45_encode(&bytes));
        let payload = decode_pairing_code(&code).unwrap();
        assert_eq!(payload.pair_host, "192.168.1.7");
        assert_eq!(payload.pair_port, 43123);
        assert_eq!(payload.token, [7; 16]);
        assert_eq!(payload.tls_certificate_sha256, [9; 32]);
    }

    #[test]
    fn rejects_wrong_version_and_truncated_payloads() {
        assert!(matches!(
            decode_pairing_code("WP2:BB8"),
            Err(PairingError::BadPrefix)
        ));
        assert!(matches!(
            decode_pairing_code("WP3:00"),
            Err(PairingError::BadEncoding)
        ));
    }

    #[test]
    fn base45_matches_rfc_vectors() {
        for (plain, encoded) in [
            ("AB", "BB8"),
            ("Hello!!", "%69 VD92EX0"),
            ("base-45", "UJCLQE7W581"),
        ] {
            assert_eq!(base45_decode(encoded).unwrap(), plain.as_bytes());
        }
    }
}
