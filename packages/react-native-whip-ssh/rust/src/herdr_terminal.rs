//! Product-specific Herdr terminal bridge lifecycle.

use std::collections::HashMap;
use std::ffi::{CStr, c_char};
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use tokio::sync::oneshot;

use crate::herdr_codec::{
    self, CodecError, MAX_FRAME_BYTES, ServerMessage, decode, validate_protocol,
};
use crate::russh_transport;

const WELCOME_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, uniffi::Record)]
pub struct HerdrTerminalControlEvent {
    pub client_key: String,
    pub terminal_id: String,
    pub kind: String,
    pub text: Option<String>,
    pub body: Option<String>,
    pub flag: Option<bool>,
    pub notification_kind: Option<u32>,
    pub count: Option<u32>,
}

#[uniffi::export(with_foreign)]
pub trait HerdrTerminalEventSink: Send + Sync {
    #[allow(clippy::too_many_arguments)]
    fn terminal_frame(
        &self,
        client_key: String,
        terminal_id: String,
        sequence: u64,
        width: u16,
        height: u16,
        full: bool,
        bytes: Vec<u8>,
    );
    fn graphics_frame(&self, client_key: String, terminal_id: String, bytes: Vec<u8>);
    fn control(&self, event: HerdrTerminalControlEvent);
}

#[derive(Clone, Debug, thiserror::Error, uniffi::Error, PartialEq, Eq)]
pub enum HerdrBridgeError {
    #[error("{0}")]
    UnsupportedProtocol(String),
    #[error("{0}")]
    MalformedServerFrame(String),
    #[error("{0}")]
    WelcomeTimeout(String),
    #[error("{0}")]
    WelcomeProtocolMismatch(String),
    #[error("{0}")]
    UnsupportedEncoding(String),
    #[error("{0}")]
    ServerRejectedWelcome(String),
    #[error("{0}")]
    ClosedBeforeHandshake(String),
    #[error("{0}")]
    BridgeUnavailable(String),
    #[error("{0}")]
    BridgeClosed(String),
}

impl From<CodecError> for HerdrBridgeError {
    fn from(error: CodecError) -> Self {
        match error {
            CodecError::UnsupportedProtocol(_) => Self::UnsupportedProtocol(error.to_string()),
            _ => Self::MalformedServerFrame(error.to_string()),
        }
    }
}

#[derive(Clone, Debug)]
enum ProtocolState {
    AwaitingWelcome,
    Ready,
    Attached(String),
    Closing,
    Closed,
}

struct Bridge {
    id: u64,
    client_key: String,
    channel_id: String,
    protocol: u32,
    state: Mutex<ProtocolState>,
    opened: Mutex<Option<oneshot::Sender<Result<(), HerdrBridgeError>>>>,
    welcomed: Mutex<Option<oneshot::Sender<Result<(), HerdrBridgeError>>>>,
}

#[derive(Default)]
struct Registry {
    bridges: HashMap<u64, Arc<Bridge>>,
    prepared: HashMap<String, u64>,
    active: HashMap<(String, String), u64>,
}

static NEXT_BRIDGE_ID: AtomicU64 = AtomicU64::new(1);
static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
static EVENT_SINK: OnceLock<RwLock<Option<Arc<dyn HerdrTerminalEventSink>>>> = OnceLock::new();

fn registry() -> &'static Mutex<Registry> {
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}

fn event_sink() -> &'static RwLock<Option<Arc<dyn HerdrTerminalEventSink>>> {
    EVENT_SINK.get_or_init(|| RwLock::new(None))
}

fn bridge_for_id(id: u64) -> Option<Arc<Bridge>> {
    registry().lock().bridges.get(&id).cloned()
}

fn active_bridge(client_key: &str, terminal_id: &str) -> Option<Arc<Bridge>> {
    let registry = registry().lock();
    registry
        .active
        .get(&(client_key.to_owned(), terminal_id.to_owned()))
        .and_then(|id| registry.bridges.get(id))
        .cloned()
}

fn remove_bridge(id: u64) {
    let mut registry = registry().lock();
    registry.prepared.retain(|_, bridge_id| *bridge_id != id);
    registry.active.retain(|_, bridge_id| *bridge_id != id);
    registry.bridges.remove(&id);
}

fn c_error(error: *const c_char) -> Option<String> {
    if error.is_null() {
        None
    } else {
        Some(
            unsafe { CStr::from_ptr(error) }
                .to_string_lossy()
                .into_owned(),
        )
    }
}

unsafe extern "C" fn transport_opened(id: u64, error: *const c_char) {
    let Some(bridge) = bridge_for_id(id) else {
        return;
    };
    let result = c_error(error)
        .map(|message| Err(HerdrBridgeError::BridgeUnavailable(message)))
        .unwrap_or(Ok(()));
    if let Some(sender) = bridge.opened.lock().take() {
        let _ = sender.send(result);
    }
}

unsafe extern "C" fn transport_frame(id: u64, bytes: *const u8, length: usize) {
    let Some(bridge) = bridge_for_id(id) else {
        return;
    };
    if bytes.is_null() && length != 0 {
        bridge.protocol_failure(HerdrBridgeError::MalformedServerFrame(
            "native SSH transport delivered a null frame".to_owned(),
        ));
        return;
    }
    let bytes = if length == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(bytes, length) }
    };
    bridge.handle_frame(bytes);
}

unsafe extern "C" fn transport_closed(id: u64, reason: *const c_char) {
    let Some(bridge) = bridge_for_id(id) else {
        return;
    };
    bridge.transport_closed(
        c_error(reason).unwrap_or_else(|| "Herdr terminal bridge closed".to_owned()),
    );
}

impl Bridge {
    fn terminal_id(&self) -> Option<String> {
        match &*self.state.lock() {
            ProtocolState::Attached(terminal_id) => Some(terminal_id.clone()),
            _ => None,
        }
    }

    fn finish_welcome(&self, result: Result<(), HerdrBridgeError>) {
        if let Some(sender) = self.welcomed.lock().take() {
            let _ = sender.send(result);
        }
    }

    fn handle_frame(&self, bytes: &[u8]) {
        let message = match decode(bytes, self.protocol) {
            Ok(message) => message,
            Err(error) => {
                self.protocol_failure(error.into());
                return;
            }
        };
        let state = self.state.lock().clone();
        match state {
            ProtocolState::AwaitingWelcome => self.handle_welcome(message),
            ProtocolState::Ready => {
                // A prepared bridge has negotiated but is not attached yet.
                // Herdr should not send normal traffic in this state.
            }
            ProtocolState::Attached(terminal_id) => {
                if !matches!(message, ServerMessage::Welcome { .. }) {
                    self.dispatch(&terminal_id, message);
                }
            }
            ProtocolState::Closing | ProtocolState::Closed => {}
        }
    }

    fn handle_welcome(&self, message: ServerMessage) {
        let ServerMessage::Welcome {
            protocol,
            encoding,
            error,
        } = message
        else {
            self.protocol_failure(HerdrBridgeError::MalformedServerFrame(
                "Herdr bridge did not send Welcome first".to_owned(),
            ));
            return;
        };
        let result = if let Some(error) = error {
            Err(HerdrBridgeError::ServerRejectedWelcome(format!(
                "Herdr bridge rejected protocol {}: {error}",
                self.protocol
            )))
        } else if protocol != self.protocol {
            Err(HerdrBridgeError::WelcomeProtocolMismatch(format!(
                "Herdr bridge negotiation mismatch (protocol {protocol}, encoding {encoding})"
            )))
        } else if encoding != 1 {
            Err(HerdrBridgeError::UnsupportedEncoding(format!(
                "Herdr bridge negotiation mismatch (protocol {protocol}, encoding {encoding})"
            )))
        } else {
            Ok(())
        };
        match result {
            Ok(()) => {
                *self.state.lock() = ProtocolState::Ready;
                self.finish_welcome(Ok(()));
            }
            Err(error) => self.protocol_failure(error),
        }
    }

    fn dispatch(&self, terminal_id: &str, message: ServerMessage) {
        let sink = event_sink().read().clone();
        let Some(sink) = sink else {
            if matches!(message, ServerMessage::Closed { .. }) {
                self.close_transport();
            }
            return;
        };
        match message {
            ServerMessage::Terminal {
                sequence,
                width,
                height,
                full,
                bytes,
            } => sink.terminal_frame(
                self.client_key.clone(),
                terminal_id.to_owned(),
                sequence,
                width,
                height,
                full,
                bytes,
            ),
            ServerMessage::Graphics { bytes } => {
                sink.graphics_frame(self.client_key.clone(), terminal_id.to_owned(), bytes)
            }
            ServerMessage::Closed { reason } => {
                sink.control(self.control(terminal_id, "closed", reason, None, None, None, None));
                self.close_transport();
            }
            ServerMessage::Notify { kind, text, body } => sink.control(self.control(
                terminal_id,
                "notify",
                Some(text),
                body,
                None,
                Some(kind),
                None,
            )),
            ServerMessage::Clipboard { text } => sink.control(self.control(
                terminal_id,
                "clipboard",
                Some(text),
                None,
                None,
                None,
                None,
            )),
            ServerMessage::Title { title } => {
                sink.control(self.control(terminal_id, "title", title, None, None, None, None))
            }
            ServerMessage::ReloadSoundConfig => sink.control(self.control(
                terminal_id,
                "reload_sound_config",
                None,
                None,
                None,
                None,
                None,
            )),
            ServerMessage::MouseCapture { enabled } => sink.control(self.control(
                terminal_id,
                "mouse_capture",
                None,
                None,
                Some(enabled),
                None,
                None,
            )),
            ServerMessage::KittyKeyboardReportAll { enabled } => sink.control(self.control(
                terminal_id,
                "kitty_keyboard_report_all",
                None,
                None,
                Some(enabled),
                None,
                None,
            )),
            ServerMessage::PrefixInputSource { enabled } => sink.control(self.control(
                terminal_id,
                "prefix_input_source",
                None,
                None,
                Some(enabled),
                None,
                None,
            )),
            ServerMessage::TerminalBell { count } => sink.control(self.control(
                terminal_id,
                "terminal_bell",
                None,
                None,
                None,
                None,
                Some(u32::from(count)),
            )),
            ServerMessage::Ignored { .. } => {
                sink.control(self.control(terminal_id, "ignored", None, None, None, None, None))
            }
            ServerMessage::Welcome { .. } => {}
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn control(
        &self,
        terminal_id: &str,
        kind: &str,
        text: Option<String>,
        body: Option<String>,
        flag: Option<bool>,
        notification_kind: Option<u32>,
        count: Option<u32>,
    ) -> HerdrTerminalControlEvent {
        HerdrTerminalControlEvent {
            client_key: self.client_key.clone(),
            terminal_id: terminal_id.to_owned(),
            kind: kind.to_owned(),
            text,
            body,
            flag,
            notification_kind,
            count,
        }
    }

    fn emit_closed(&self, reason: String) {
        let Some(terminal_id) = self.terminal_id() else {
            return;
        };
        if crate::host_runtime::terminal_bridge_closed(
            &self.client_key,
            &terminal_id,
            reason.clone(),
        ) {
            return;
        }
        if let Some(sink) = event_sink().read().clone() {
            sink.control(self.control(
                &terminal_id,
                "closed",
                Some(reason),
                None,
                None,
                None,
                None,
            ));
        }
    }

    fn protocol_failure(&self, error: HerdrBridgeError) {
        let was_handshaking = matches!(*self.state.lock(), ProtocolState::AwaitingWelcome);
        if was_handshaking {
            *self.state.lock() = ProtocolState::Closed;
            self.finish_welcome(Err(error));
        } else {
            self.emit_closed(error.to_string());
            *self.state.lock() = ProtocolState::Closing;
        }
        let _ = russh_transport::close(&self.client_key, &self.channel_id);
        remove_bridge(self.id);
    }

    fn transport_closed(&self, reason: String) {
        let state = self.state.lock().clone();
        match state {
            ProtocolState::AwaitingWelcome => {
                let error = HerdrBridgeError::ClosedBeforeHandshake(format!(
                    "Herdr bridge closed before Welcome: {reason}"
                ));
                *self.state.lock() = ProtocolState::Closed;
                if let Some(sender) = self.opened.lock().take() {
                    let _ = sender.send(Err(error.clone()));
                }
                self.finish_welcome(Err(error));
            }
            ProtocolState::Attached(_) => self.emit_closed(reason),
            ProtocolState::Ready | ProtocolState::Closing | ProtocolState::Closed => {}
        }
        *self.state.lock() = ProtocolState::Closed;
        remove_bridge(self.id);
    }

    fn close_transport(&self) {
        *self.state.lock() = ProtocolState::Closing;
        let _ = russh_transport::close(&self.client_key, &self.channel_id);
        remove_bridge(self.id);
    }
}

#[allow(clippy::too_many_arguments)]
async fn open_bridge(
    client_key: String,
    socket_path: String,
    protocol: u32,
    columns: u32,
    rows: u32,
    cell_width_px: u32,
    cell_height_px: u32,
    terminal_attach_launch_mode: u8,
) -> Result<Arc<Bridge>, HerdrBridgeError> {
    validate_protocol(protocol)?;
    let hello = herdr_codec::hello(
        protocol,
        columns,
        rows,
        cell_width_px,
        cell_height_px,
        terminal_attach_launch_mode,
    )?;
    let id = NEXT_BRIDGE_ID.fetch_add(1, Ordering::Relaxed);
    let channel_id = format!("whip-herdr-{id}");
    let (opened_sender, opened_receiver) = oneshot::channel();
    let (welcome_sender, welcome_receiver) = oneshot::channel();
    let bridge = Arc::new(Bridge {
        id,
        client_key: client_key.clone(),
        channel_id: channel_id.clone(),
        protocol,
        state: Mutex::new(ProtocolState::AwaitingWelcome),
        opened: Mutex::new(Some(opened_sender)),
        welcomed: Mutex::new(Some(welcome_sender)),
    });
    registry().lock().bridges.insert(id, bridge.clone());

    if let Err(error) = russh_transport::open(
        id,
        &client_key,
        &channel_id,
        &socket_path,
        MAX_FRAME_BYTES,
        transport_opened,
        transport_frame,
        transport_closed,
    ) {
        remove_bridge(id);
        return Err(HerdrBridgeError::BridgeUnavailable(error));
    }
    match opened_receiver.await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            remove_bridge(id);
            return Err(error);
        }
        Err(_) => {
            remove_bridge(id);
            return Err(HerdrBridgeError::BridgeUnavailable(
                "native SSH transport did not finish opening the Herdr bridge".to_owned(),
            ));
        }
    }
    if let Err(error) = russh_transport::write(&client_key, &channel_id, &hello) {
        bridge.close_transport();
        return Err(HerdrBridgeError::BridgeUnavailable(error));
    }
    match tokio::time::timeout(WELCOME_TIMEOUT, welcome_receiver).await {
        Ok(Ok(Ok(()))) => Ok(bridge),
        Ok(Ok(Err(error))) => Err(error),
        Ok(Err(_)) => Err(HerdrBridgeError::BridgeClosed(
            "Herdr Welcome wait was cancelled".to_owned(),
        )),
        Err(_) => {
            bridge.close_transport();
            Err(HerdrBridgeError::WelcomeTimeout(
                "timed out waiting for Herdr Welcome".to_owned(),
            ))
        }
    }
}

#[uniffi::export]
pub fn set_herdr_terminal_event_sink(sink: Arc<dyn HerdrTerminalEventSink>) {
    *event_sink().write() = Some(sink);
}

#[uniffi::export]
pub fn clear_herdr_terminal_event_sink() {
    *event_sink().write() = None;
}

async fn prepare_bridge_on_runtime(
    client_key: String,
    socket_path: String,
    protocol: u32,
    columns: u32,
    rows: u32,
    cell_width_px: u32,
    cell_height_px: u32,
) -> Result<(), HerdrBridgeError> {
    if registry().lock().prepared.contains_key(&client_key) {
        return Ok(());
    }
    let bridge = open_bridge(
        client_key.clone(),
        socket_path,
        protocol,
        columns,
        rows,
        cell_width_px,
        cell_height_px,
        1,
    )
    .await?;
    registry().lock().prepared.insert(client_key, bridge.id);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn start_bridge_on_runtime(
    client_key: String,
    socket_path: String,
    protocol: u32,
    terminal_id: String,
    takeover: bool,
    columns: u32,
    rows: u32,
    cell_width_px: u32,
    cell_height_px: u32,
    terminal_attach_launch_mode: u8,
) -> Result<(), HerdrBridgeError> {
    if active_bridge(&client_key, &terminal_id).is_some() {
        return Ok(());
    }
    let prepared_id = registry().lock().prepared.remove(&client_key);
    let mut bridge = prepared_id.and_then(bridge_for_id);
    if bridge
        .as_ref()
        .is_some_and(|bridge| bridge.protocol != protocol)
    {
        bridge.take().unwrap().close_transport();
    }
    let bridge = match bridge {
        Some(bridge) => bridge,
        None => {
            open_bridge(
                client_key.clone(),
                socket_path,
                protocol,
                columns,
                rows,
                cell_width_px,
                cell_height_px,
                terminal_attach_launch_mode,
            )
            .await?
        }
    };
    *bridge.state.lock() = ProtocolState::Attached(terminal_id.clone());
    registry()
        .lock()
        .active
        .insert((client_key.clone(), terminal_id.clone()), bridge.id);
    if let Err(error) = russh_transport::write(
        &client_key,
        &bridge.channel_id,
        &herdr_codec::attach(&terminal_id, takeover),
    ) {
        bridge.close_transport();
        return Err(HerdrBridgeError::BridgeClosed(error));
    }
    Ok(())
}

#[uniffi::export]
pub async fn prepare_herdr_terminal_bridge(
    client_key: String,
    socket_path: String,
    protocol: u32,
    columns: u32,
    rows: u32,
    cell_width_px: u32,
    cell_height_px: u32,
) -> Result<(), HerdrBridgeError> {
    let runtime = crate::runtime().map_err(HerdrBridgeError::BridgeUnavailable)?;
    runtime
        .spawn(prepare_bridge_on_runtime(
            client_key,
            socket_path,
            protocol,
            columns,
            rows,
            cell_width_px,
            cell_height_px,
        ))
        .await
        .map_err(|error| {
            HerdrBridgeError::BridgeUnavailable(format!(
                "Herdr bridge runtime task failed: {error}"
            ))
        })?
}

#[allow(clippy::too_many_arguments)]
#[uniffi::export]
pub async fn start_herdr_terminal_bridge(
    client_key: String,
    socket_path: String,
    protocol: u32,
    terminal_id: String,
    takeover: bool,
    columns: u32,
    rows: u32,
    cell_width_px: u32,
    cell_height_px: u32,
    terminal_attach_launch_mode: u8,
) -> Result<(), HerdrBridgeError> {
    let runtime = crate::runtime().map_err(HerdrBridgeError::BridgeUnavailable)?;
    runtime
        .spawn(start_bridge_on_runtime(
            client_key,
            socket_path,
            protocol,
            terminal_id,
            takeover,
            columns,
            rows,
            cell_width_px,
            cell_height_px,
            terminal_attach_launch_mode,
        ))
        .await
        .map_err(|error| {
            HerdrBridgeError::BridgeUnavailable(format!(
                "Herdr bridge runtime task failed: {error}"
            ))
        })?
}

fn require_active_bridge(
    client_key: &str,
    terminal_id: &str,
) -> Result<Arc<Bridge>, HerdrBridgeError> {
    active_bridge(client_key, terminal_id).ok_or_else(|| {
        HerdrBridgeError::BridgeUnavailable(format!(
            "Herdr bridge is not active for terminal {terminal_id}"
        ))
    })
}

#[uniffi::export]
pub fn herdr_terminal_input(
    client_key: String,
    terminal_id: String,
    text: String,
) -> Result<(), HerdrBridgeError> {
    let bridge = require_active_bridge(&client_key, &terminal_id)?;
    russh_transport::write(
        &client_key,
        &bridge.channel_id,
        &herdr_codec::input(text.as_bytes()),
    )
    .map_err(HerdrBridgeError::BridgeClosed)
}

#[uniffi::export]
pub fn herdr_terminal_resize(
    client_key: String,
    terminal_id: String,
    columns: u32,
    rows: u32,
    cell_width_px: u32,
    cell_height_px: u32,
) -> Result<(), HerdrBridgeError> {
    let bridge = require_active_bridge(&client_key, &terminal_id)?;
    let payload = herdr_codec::resize(columns, rows, cell_width_px, cell_height_px)?;
    russh_transport::write(&client_key, &bridge.channel_id, &payload)
        .map_err(HerdrBridgeError::BridgeClosed)
}

#[allow(clippy::too_many_arguments)]
#[uniffi::export]
pub fn herdr_terminal_scroll(
    client_key: String,
    terminal_id: String,
    up: bool,
    lines: u32,
    column: Option<f64>,
    row: Option<f64>,
    modifiers: u8,
) -> Result<(), HerdrBridgeError> {
    let bridge = require_active_bridge(&client_key, &terminal_id)?;
    let payload = herdr_codec::scroll(up, lines, column, row, modifiers)?;
    russh_transport::write(&client_key, &bridge.channel_id, &payload)
        .map_err(HerdrBridgeError::BridgeClosed)
}

#[uniffi::export]
pub fn close_herdr_terminal_bridge(client_key: String, terminal_id: String) {
    let Some(bridge) = active_bridge(&client_key, &terminal_id) else {
        return;
    };
    {
        let mut registry = registry().lock();
        registry.active.remove(&(client_key.clone(), terminal_id));
    }
    *bridge.state.lock() = ProtocolState::Closing;
    let _ = russh_transport::write(&client_key, &bridge.channel_id, &herdr_codec::detach());
    bridge.close_transport();
}

#[uniffi::export]
pub fn close_all_herdr_terminal_bridges(client_key: String) {
    let bridges = {
        let registry = registry().lock();
        registry
            .bridges
            .values()
            .filter(|bridge| bridge.client_key == client_key)
            .cloned()
            .collect::<Vec<_>>()
    };
    for bridge in bridges {
        if bridge.terminal_id().is_some() {
            let _ = russh_transport::write(&client_key, &bridge.channel_id, &herdr_codec::detach());
        }
        bridge.close_transport();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_bridge(
        protocol: u32,
    ) -> (Arc<Bridge>, oneshot::Receiver<Result<(), HerdrBridgeError>>) {
        let (opened, _) = oneshot::channel();
        let (welcome_sender, welcome_receiver) = oneshot::channel();
        (
            Arc::new(Bridge {
                id: u64::MAX,
                client_key: "test".to_owned(),
                channel_id: "test-channel".to_owned(),
                protocol,
                state: Mutex::new(ProtocolState::AwaitingWelcome),
                opened: Mutex::new(Some(opened)),
                welcomed: Mutex::new(Some(welcome_sender)),
            }),
            welcome_receiver,
        )
    }

    fn received(
        receiver: oneshot::Receiver<Result<(), HerdrBridgeError>>,
    ) -> Result<(), HerdrBridgeError> {
        receiver.blocking_recv().expect("handshake result")
    }

    #[test]
    fn handshake_rejects_non_welcome_first_frame() {
        let (bridge, receiver) = test_bridge(20);
        bridge.handle_frame(&[8]);
        assert!(matches!(
            received(receiver),
            Err(HerdrBridgeError::MalformedServerFrame(message))
                if message == "Herdr bridge did not send Welcome first"
        ));
    }

    #[test]
    fn handshake_rejects_protocol_mismatch() {
        let (bridge, receiver) = test_bridge(20);
        bridge.handle_frame(&[0, 19, 1, 0]);
        assert!(matches!(
            received(receiver),
            Err(HerdrBridgeError::WelcomeProtocolMismatch(_))
        ));
    }

    #[test]
    fn handshake_rejects_encoding_mismatch() {
        let (bridge, receiver) = test_bridge(20);
        bridge.handle_frame(&[0, 20, 0, 0]);
        assert!(matches!(
            received(receiver),
            Err(HerdrBridgeError::UnsupportedEncoding(_))
        ));
    }

    #[test]
    fn handshake_rejects_server_error() {
        let (bridge, receiver) = test_bridge(20);
        bridge.handle_frame(&[0, 20, 1, 1, 3, b'b', b'a', b'd']);
        assert!(matches!(
            received(receiver),
            Err(HerdrBridgeError::ServerRejectedWelcome(_))
        ));
    }

    #[test]
    fn handshake_rejects_bridge_close_before_welcome() {
        let (bridge, receiver) = test_bridge(20);
        bridge.transport_closed("remote Unix socket reached EOF".to_owned());
        assert!(matches!(
            received(receiver),
            Err(HerdrBridgeError::ClosedBeforeHandshake(message))
                if message.contains("closed before Welcome")
        ));
    }

    #[test]
    fn handshake_reports_close_that_races_the_open_callback() {
        let (opened_sender, opened_receiver) = oneshot::channel();
        let (welcome_sender, _) = oneshot::channel();
        let bridge = Arc::new(Bridge {
            id: u64::MAX,
            client_key: "test".to_owned(),
            channel_id: "test-channel".to_owned(),
            protocol: 20,
            state: Mutex::new(ProtocolState::AwaitingWelcome),
            opened: Mutex::new(Some(opened_sender)),
            welcomed: Mutex::new(Some(welcome_sender)),
        });

        bridge.transport_closed("remote Unix socket reached EOF".to_owned());

        assert!(matches!(
            received(opened_receiver),
            Err(HerdrBridgeError::ClosedBeforeHandshake(message))
                if message.contains("closed before Welcome")
        ));
    }

    #[test]
    fn handshake_accepts_matching_terminal_ansi_welcome() {
        let (bridge, receiver) = test_bridge(20);
        bridge.handle_frame(&[0, 20, 1, 0]);
        assert_eq!(received(receiver), Ok(()));
        assert!(matches!(*bridge.state.lock(), ProtocolState::Ready));
    }
}
