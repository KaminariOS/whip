//! Private QR-pinned bootstrap SSH connection used for WP4 pairing.

mod pairing;

use serde_json::json;

uniffi::setup_scaffolding!();

#[uniffi::export]
pub async fn pair_host(code: String, public_key: String, device_name: String) -> String {
    match pairing::pair_host(&code, &public_key, &device_name).await {
        Ok(value) => json!({ "ok": true, "value": value }).to_string(),
        Err(error) => json!({ "ok": false, "error": error.to_string() }).to_string(),
    }
}
