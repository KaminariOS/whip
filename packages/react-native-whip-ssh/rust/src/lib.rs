//! Private QR-pinned bootstrap SSH connection used for WP4 pairing.

mod herdr_api;
mod herdr_codec;
mod herdr_events;
mod herdr_terminal;
mod host_runtime;
mod host_state;
mod pairing;
mod russh_transport;

pub use herdr_api::*;
pub use herdr_events::*;
pub use herdr_terminal::*;
pub use host_runtime::*;
pub use host_state::*;

use std::sync::OnceLock;

use serde_json::json;
use tokio::runtime::Runtime;

uniffi::setup_scaffolding!();

static RUNTIME: OnceLock<Result<Runtime, String>> = OnceLock::new();

fn runtime() -> Result<&'static Runtime, String> {
    RUNTIME
        .get_or_init(|| Runtime::new().map_err(|error| error.to_string()))
        .as_ref()
        .map_err(Clone::clone)
}

async fn pair_host_on_runtime(code: String, public_key: String, device_name: String) -> String {
    match pairing::pair_host(&code, &public_key, &device_name).await {
        Ok(value) => json!({ "ok": true, "value": value }).to_string(),
        Err(error) => json!({ "ok": false, "error": error.to_string() }).to_string(),
    }
}

#[uniffi::export]
pub async fn pair_host(code: String, public_key: String, device_name: String) -> String {
    let task = match runtime() {
        Ok(runtime) => runtime.spawn(pair_host_on_runtime(code, public_key, device_name)),
        Err(error) => {
            return json!({
                "ok": false,
                "error": format!("failed to initialize pairing runtime: {error}"),
            })
            .to_string();
        }
    };
    match task.await {
        Ok(response) => response,
        Err(error) => json!({
            "ok": false,
            "error": format!("pairing runtime task failed: {error}"),
        })
        .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        future::Future,
        sync::Arc,
        task::{Context, Poll, Wake, Waker},
        thread,
    };

    use serde_json::Value;

    use super::pair_host;

    const BASE45_ALPHABET: &[u8; 45] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

    struct ThreadWaker(thread::Thread);

    impl Wake for ThreadWaker {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }

    fn block_on_without_tokio<F: Future>(future: F) -> F::Output {
        let waker = Waker::from(Arc::new(ThreadWaker(thread::current())));
        let mut context = Context::from_waker(&waker);
        let mut future = std::pin::pin!(future);
        loop {
            match future.as_mut().poll(&mut context) {
                Poll::Ready(output) => return output,
                Poll::Pending => thread::park(),
            }
        }
    }

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

    fn unreachable_pairing_code() -> String {
        let mut payload = vec![1, 127, 0, 0, 1];
        payload.extend_from_slice(&1_u16.to_be_bytes());
        payload.push(4);
        payload.extend_from_slice(b"test");
        payload.extend_from_slice(&[7; 32]);
        payload.extend_from_slice(&[9; 32]);
        format!("WP4:{}", base45_encode(&payload))
    }

    #[test]
    fn exported_pairing_future_supplies_its_own_tokio_runtime() {
        let response = block_on_without_tokio(pair_host(
            unreachable_pairing_code(),
            "ssh-ed25519 AAAA test".to_owned(),
            "test device".to_owned(),
        ));
        let response: Value = serde_json::from_str(&response).unwrap();
        let error = response["error"].as_str().unwrap();

        assert_eq!(response["ok"], false);
        assert!(!error.contains("no reactor running"), "{error}");
        assert!(!error.contains("pairing runtime task failed"), "{error}");
    }
}
