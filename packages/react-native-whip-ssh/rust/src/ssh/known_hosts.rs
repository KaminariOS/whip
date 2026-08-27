//! OpenSSH known_hosts parsing and verification for the Whip SSH core.

use base64::Engine as _;
use hmac::{Hmac, Mac};
use russh::keys::PublicKey;
use serde::Serialize;
use sha1::Sha1;
use sha2::{Digest, Sha256};

#[derive(Debug, Default)]
pub struct KnownHosts {
    entries: Vec<Entry>,
}

#[derive(Debug)]
struct Entry {
    hosts: Vec<String>,
    algorithm: String,
    key: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyChallenge {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub public_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct TrustedHostKey {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub public_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error, uniffi::Error)]
pub enum KnownHostStoreError {
    #[error("trusted host name is empty")]
    EmptyHost,
    #[error("trusted host port must be between 1 and 65535, received {0}")]
    InvalidPort(u16),
    #[error("trusted host key is malformed: {0}")]
    MalformedKey(String),
    #[error("trusted host key type {0} does not match decoded key type {1}")]
    KeyTypeMismatch(String, String),
}

#[derive(Debug)]
pub enum HostKeyDecision {
    Trusted,
    Unknown(HostKeyChallenge),
    Changed(HostKeyChallenge),
}

impl KnownHosts {
    pub fn parse(contents: &str) -> Self {
        let entries = contents
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') || line.starts_with('@') {
                    return None;
                }
                let mut fields = line.split_whitespace();
                let hosts = fields.next()?.split(',').map(str::to_owned).collect();
                let algorithm = fields.next()?.to_owned();
                let key = base64::engine::general_purpose::STANDARD
                    .decode(fields.next()?)
                    .ok()?;
                Some(Entry {
                    hosts,
                    algorithm,
                    key,
                })
            })
            .collect();
        Self { entries }
    }

    pub fn check(&self, host: &str, port: u16, key: &PublicKey) -> HostKeyDecision {
        let encoded_key = key.to_bytes().unwrap_or_default();
        let normalized_host = normalized_host(host);
        let canonical_host = canonical_host(&normalized_host, port);
        let matching: Vec<&Entry> = self
            .entries
            .iter()
            .filter(|entry| {
                entry
                    .hosts
                    .iter()
                    .any(|candidate| host_matches(candidate, &canonical_host))
            })
            .collect();
        if matching
            .iter()
            .any(|entry| entry.algorithm == key.algorithm().as_str() && entry.key == encoded_key)
        {
            return HostKeyDecision::Trusted;
        }
        let challenge = HostKeyChallenge::new(&normalized_host, port, key, encoded_key);
        if matching.is_empty() {
            HostKeyDecision::Unknown(challenge)
        } else {
            HostKeyDecision::Changed(challenge)
        }
    }

    pub fn from_trusted(entries: Vec<TrustedHostKey>) -> Result<Self, KnownHostStoreError> {
        let entries = entries
            .into_iter()
            .map(|entry| {
                let host = normalize_host(&entry.host)?;
                if entry.port == 0 {
                    return Err(KnownHostStoreError::InvalidPort(entry.port));
                }
                let encoded = public_key_base64(&entry.key_type, &entry.public_key)?;
                let key = russh::keys::parse_public_key_base64(encoded)
                    .map_err(|error| KnownHostStoreError::MalformedKey(error.to_string()))?;
                let decoded_type = key.algorithm().as_str().to_owned();
                if decoded_type != entry.key_type {
                    return Err(KnownHostStoreError::KeyTypeMismatch(
                        entry.key_type,
                        decoded_type,
                    ));
                }
                Ok(Entry {
                    hosts: vec![canonical_host(&host, entry.port)],
                    algorithm: key.algorithm().as_str().to_owned(),
                    key: key
                        .to_bytes()
                        .map_err(|error| KnownHostStoreError::MalformedKey(error.to_string()))?,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self { entries })
    }
}

fn normalize_host(host: &str) -> Result<String, KnownHostStoreError> {
    let host = normalized_host(host);
    if host.is_empty() {
        return Err(KnownHostStoreError::EmptyHost);
    }
    Ok(host)
}

fn normalized_host(host: &str) -> String {
    let host = host.trim();
    host.strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host)
        .to_lowercase()
}

fn canonical_host(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_owned()
    } else {
        format!("[{host}]:{port}")
    }
}

fn public_key_base64<'a>(
    key_type: &str,
    public_key: &'a str,
) -> Result<&'a str, KnownHostStoreError> {
    let mut fields = public_key.split_whitespace();
    let first = fields
        .next()
        .ok_or_else(|| KnownHostStoreError::MalformedKey("key is empty".to_owned()))?;
    if first.starts_with("ssh-") || first.starts_with("ecdsa-") || first.starts_with("sk-") {
        if first != key_type {
            return Err(KnownHostStoreError::KeyTypeMismatch(
                key_type.to_owned(),
                first.to_owned(),
            ));
        }
        fields
            .next()
            .ok_or_else(|| KnownHostStoreError::MalformedKey("key body is missing".to_owned()))
    } else {
        Ok(first)
    }
}

fn host_matches(pattern: &str, canonical_host: &str) -> bool {
    if pattern == canonical_host {
        return true;
    }
    let Some(hashed) = pattern.strip_prefix("|1|") else {
        return false;
    };
    let mut fields = hashed.split('|');
    let (Some(salt), Some(expected), None) = (fields.next(), fields.next(), fields.next()) else {
        return false;
    };
    let Ok(salt) = base64::engine::general_purpose::STANDARD.decode(salt) else {
        return false;
    };
    let Ok(expected) = base64::engine::general_purpose::STANDARD.decode(expected) else {
        return false;
    };
    Hmac::<Sha1>::new_from_slice(&salt).is_ok_and(|mut hmac| {
        hmac.update(canonical_host.as_bytes());
        hmac.verify_slice(&expected).is_ok()
    })
}

impl HostKeyChallenge {
    fn new(host: &str, port: u16, key: &PublicKey, encoded_key: Vec<u8>) -> Self {
        let digest = Sha256::digest(&encoded_key);
        let fingerprint = format!(
            "SHA256:{}",
            base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest),
        );
        let key_type = key.algorithm().as_str().to_owned();
        let public_key = format!(
            "{} {}",
            key_type,
            base64::engine::general_purpose::STANDARD.encode(encoded_key),
        );
        Self {
            host: host.to_owned(),
            port,
            key_type,
            fingerprint,
            public_key,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> russh::keys::PrivateKey {
        let mut rng =
            russh::keys::ssh_key::rand_core::UnwrapErr(russh::keys::ssh_key::getrandom::SysRng);
        russh::keys::PrivateKey::random(&mut rng, russh::keys::Algorithm::Ed25519).unwrap()
    }

    fn trusted(host: &str, port: u16, key: &russh::keys::PrivateKey) -> TrustedHostKey {
        TrustedHostKey {
            host: host.to_owned(),
            port,
            key_type: key.public_key().algorithm().as_str().to_owned(),
            public_key: key.public_key().to_openssh().unwrap(),
        }
    }

    #[test]
    fn parser_ignores_comments_and_invalid_lines() {
        let parsed = KnownHosts::parse("# comment\ninvalid\nexample.com ssh-ed25519 AAAA\n");
        assert_eq!(parsed.entries.len(), 1);
        assert_eq!(parsed.entries[0].hosts, ["example.com"]);
    }

    #[test]
    fn matches_hashed_hosts_and_scopes_nonstandard_ports() {
        use base64::engine::general_purpose::STANDARD;

        let salt = b"russh-known-hosts-test";
        let mut hmac = Hmac::<Sha1>::new_from_slice(salt).unwrap();
        hmac.update(b"[example.com]:2222");
        let pattern = format!(
            "|1|{}|{}",
            STANDARD.encode(salt),
            STANDARD.encode(hmac.finalize().into_bytes())
        );
        assert!(host_matches(&pattern, "[example.com]:2222"));
        assert!(!host_matches(&pattern, "example.com"));
        assert!(!host_matches("example.com", "[example.com]:2222"));
    }

    #[test]
    fn structured_keys_normalize_dns_names_and_support_default_and_nonstandard_ports() {
        let key = test_key();
        let default = KnownHosts::from_trusted(vec![trusted("Example.COM", 22, &key)]).unwrap();
        assert!(matches!(
            default.check("example.com", 22, key.public_key()),
            HostKeyDecision::Trusted
        ));

        let nonstandard =
            KnownHosts::from_trusted(vec![trusted("192.0.2.10", 2222, &key)]).unwrap();
        assert!(matches!(
            nonstandard.check("192.0.2.10", 2222, key.public_key()),
            HostKeyDecision::Trusted
        ));
        assert!(matches!(
            nonstandard.check("192.0.2.10", 22, key.public_key()),
            HostKeyDecision::Unknown(_)
        ));
    }

    #[test]
    fn structured_keys_support_ipv6_hosts() {
        let key = test_key();
        let known = KnownHosts::from_trusted(vec![trusted("[2001:db8::1]", 2222, &key)]).unwrap();
        assert!(matches!(
            known.check("2001:DB8::1", 2222, key.public_key()),
            HostKeyDecision::Trusted
        ));
    }

    #[test]
    fn structured_keys_reject_invalid_ports_and_key_material() {
        let key = test_key();
        assert!(matches!(
            KnownHosts::from_trusted(vec![trusted("example.com", 0, &key)]),
            Err(KnownHostStoreError::InvalidPort(0))
        ));
        assert!(matches!(
            KnownHosts::from_trusted(vec![TrustedHostKey {
                host: "example.com".to_owned(),
                port: 22,
                key_type: "ssh-ed25519".to_owned(),
                public_key: "not-base64".to_owned(),
            }]),
            Err(KnownHostStoreError::MalformedKey(_))
        ));
        assert!(matches!(
            KnownHosts::from_trusted(vec![TrustedHostKey {
                host: "example.com".to_owned(),
                port: 22,
                key_type: "ssh-rsa".to_owned(),
                public_key: key.public_key().to_openssh().unwrap(),
            }]),
            Err(KnownHostStoreError::KeyTypeMismatch(_, _))
        ));
    }

    #[test]
    fn different_key_for_a_known_alias_is_changed_not_unknown() {
        let trusted_key = test_key();
        let received_key = test_key();
        let known =
            KnownHosts::from_trusted(vec![trusted("example.com", 22, &trusted_key)]).unwrap();
        assert!(matches!(
            known.check("example.com", 22, received_key.public_key()),
            HostKeyDecision::Changed(_)
        ));
    }
}
