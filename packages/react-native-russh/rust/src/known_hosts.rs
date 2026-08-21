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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyChallenge {
    host: String,
    port: u16,
    key_type: String,
    fingerprint: String,
    public_key: String,
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
        let canonical_host = if port == 22 {
            host.to_owned()
        } else {
            format!("[{host}]:{port}")
        };
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
        let challenge = HostKeyChallenge::new(host, port, key, encoded_key);
        if matching.is_empty() {
            HostKeyDecision::Unknown(challenge)
        } else {
            HostKeyDecision::Changed(challenge)
        }
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

    pub fn error_message(&self, changed: bool) -> String {
        let prefix = if changed {
            "E_HOST_KEY_CHANGED:"
        } else {
            "E_HOST_KEY_UNKNOWN:"
        };
        let details = serde_json::to_string(self)
            .unwrap_or_else(|_| r#"{"error":"could not serialize host-key details"}"#.to_owned());
        format!("{prefix}{details}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_ignores_comments_and_invalid_lines() {
        let parsed = KnownHosts::parse("# comment\ninvalid\nexample.com ssh-ed25519 AAAA\n");
        assert_eq!(parsed.entries.len(), 1);
        assert_eq!(parsed.entries[0].hosts, ["example.com"]);
    }

    #[test]
    fn matches_hashed_hosts_and_scopes_nonstandard_ports() {
        use base64::engine::general_purpose::STANDARD;

        let salt = b"whip-known-hosts-test";
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
}
