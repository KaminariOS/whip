//! Native Herdr event subscription, JSONL framing, normalization, and validation.

use std::collections::HashMap;
use std::ffi::{CStr, c_char};
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicU64, Ordering},
};

use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use serde_json::{Map, Value};
use tokio::sync::oneshot;

use crate::herdr_api::{
    HerdrPaneInfo, HerdrPaneLayoutSnapshot, HerdrTabInfo, HerdrWorkspaceInfo, HerdrWorktreeInfo,
    agent_status, bool_value, non_empty_string_value, non_negative_number, object, optional_string,
    pane, pane_layout, required, required_string, string_array, string_map, tab, workspace,
    worktree,
};
use crate::{herdr_codec, russh_transport};

const MAX_EVENT_LINE_BYTES: usize = 1024 * 1024;
const EVENT_READ_CHUNK_BYTES: usize = 32 * 1024;

const LIFECYCLE_SUBSCRIPTIONS: &[&str] = &[
    "workspace.created",
    "workspace.updated",
    "workspace.metadata_updated",
    "workspace.renamed",
    "workspace.moved",
    "workspace.reordered",
    "workspace.closed",
    "workspace.focused",
    "worktree.created",
    "worktree.opened",
    "worktree.removed",
    "tab.created",
    "tab.closed",
    "tab.focused",
    "tab.renamed",
    "tab.moved",
    "pane.created",
    "pane.closed",
    "pane.updated",
    "pane.focused",
    "pane.moved",
    "pane.exited",
    "pane.agent_detected",
    "layout.updated",
];

const EVENT_NAMES: &[&str] = &[
    "workspace.created",
    "workspace.updated",
    "workspace.metadata_updated",
    "workspace.closed",
    "workspace.renamed",
    "workspace.moved",
    "workspace.reordered",
    "workspace.focused",
    "worktree.created",
    "worktree.opened",
    "worktree.removed",
    "tab.created",
    "tab.closed",
    "tab.renamed",
    "tab.moved",
    "tab.focused",
    "pane.created",
    "pane.updated",
    "pane.closed",
    "pane.focused",
    "pane.exited",
    "pane.moved",
    "pane.output_changed",
    "pane.agent_detected",
    "pane.agent_status_changed",
    "layout.updated",
];

#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
// UniFFI data-carrying variants keep the JS boundary exhaustive. Boxing the
// records would add allocations to every event without reducing FFI payloads.
#[allow(clippy::large_enum_variant)]
pub enum HerdrEvent {
    WorkspaceCreated {
        workspace: HerdrWorkspaceInfo,
    },
    WorkspaceUpdated {
        workspace: HerdrWorkspaceInfo,
    },
    WorkspaceMetadataUpdated {
        workspace: HerdrWorkspaceInfo,
    },
    WorkspaceClosed {
        workspace_id: String,
        workspace: Option<HerdrWorkspaceInfo>,
    },
    WorkspaceRenamed {
        workspace_id: String,
        label: String,
    },
    WorkspaceMoved {
        workspace_id: String,
        insert_index: f64,
        workspaces: Vec<HerdrWorkspaceInfo>,
    },
    WorkspaceReordered {
        workspace_ids: Vec<String>,
        workspaces: Vec<HerdrWorkspaceInfo>,
        before_workspace_id: Option<String>,
    },
    WorkspaceFocused {
        workspace_id: String,
    },
    WorktreeCreated {
        workspace: HerdrWorkspaceInfo,
        worktree: HerdrWorktreeInfo,
    },
    WorktreeOpened {
        workspace: HerdrWorkspaceInfo,
        worktree: HerdrWorktreeInfo,
        already_open: bool,
    },
    WorktreeRemoved {
        workspace_id: String,
        workspace: Option<HerdrWorkspaceInfo>,
        worktree: HerdrWorktreeInfo,
        forced: bool,
    },
    TabCreated {
        tab: HerdrTabInfo,
    },
    TabClosed {
        workspace_id: String,
        tab_id: String,
    },
    TabFocused {
        workspace_id: String,
        tab_id: String,
    },
    TabRenamed {
        workspace_id: String,
        tab_id: String,
        label: String,
    },
    TabMoved {
        workspace_id: String,
        tab_id: String,
        insert_index: f64,
        tabs: Vec<HerdrTabInfo>,
    },
    PaneCreated {
        pane: HerdrPaneInfo,
    },
    PaneUpdated {
        pane: HerdrPaneInfo,
    },
    PaneClosed {
        workspace_id: String,
        pane_id: String,
    },
    PaneFocused {
        workspace_id: String,
        pane_id: String,
    },
    PaneExited {
        workspace_id: String,
        pane_id: String,
    },
    PaneMoved {
        previous_pane_id: String,
        previous_workspace_id: String,
        previous_tab_id: String,
        pane: HerdrPaneInfo,
        created_workspace: Option<HerdrWorkspaceInfo>,
        created_tab: Option<HerdrTabInfo>,
        closed_workspace_id: Option<String>,
        closed_tab_id: Option<String>,
    },
    PaneOutputChanged {
        workspace_id: String,
        pane_id: String,
        revision: f64,
    },
    PaneAgentDetected {
        workspace_id: String,
        pane_id: String,
        agent: Option<String>,
        released: bool,
        final_status: Option<String>,
    },
    PaneAgentStatusChanged {
        workspace_id: String,
        pane_id: String,
        agent_status: String,
        agent: Option<String>,
        title: Option<String>,
        display_agent: Option<String>,
        state_labels: Option<HashMap<String, String>>,
    },
    LayoutUpdated {
        layout: HerdrPaneLayoutSnapshot,
    },
    ProtocolUnknown {
        raw_event: String,
    },
    ProtocolInvalid {
        raw_event: String,
        reason: String,
    },
}

#[uniffi::export(with_foreign)]
pub trait HerdrEventSink: Send + Sync {
    fn event(&self, client_key: String, event: HerdrEvent);
    fn closed(&self, client_key: String, reason: String);
}

#[derive(Clone, Debug, thiserror::Error, uniffi::Error, PartialEq, Eq)]
pub enum HerdrEventError {
    #[error("{0}")]
    UnsupportedProtocol(String),
    #[error("{0}")]
    TransportDisconnected(String),
    #[error("{0}")]
    SubscriptionUnavailable(String),
}

#[derive(Default)]
struct JsonlEventParser {
    buffer: Vec<u8>,
    discarding_oversized_line: bool,
}

enum StreamItem {
    Event(Box<HerdrEvent>),
    ServerError(String),
}

impl JsonlEventParser {
    fn push(&mut self, bytes: &[u8]) -> Vec<StreamItem> {
        let mut items = Vec::new();
        for byte in bytes {
            if self.discarding_oversized_line {
                if *byte == b'\n' {
                    self.discarding_oversized_line = false;
                }
                continue;
            }
            if *byte == b'\n' {
                let mut line = std::mem::take(&mut self.buffer);
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                if line.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                if let Some(item) = parse_stream_line(&line) {
                    items.push(item);
                }
                continue;
            }
            self.buffer.push(*byte);
            if self.buffer.len() > MAX_EVENT_LINE_BYTES {
                self.buffer.clear();
                self.discarding_oversized_line = true;
                items.push(StreamItem::Event(Box::new(HerdrEvent::ProtocolInvalid {
                    raw_event: "event_stream".to_owned(),
                    reason: format!("event line exceeds {MAX_EVENT_LINE_BYTES} bytes"),
                })));
            }
        }
        items
    }

    fn end(&mut self) {
        self.buffer.clear();
        self.discarding_oversized_line = false;
    }
}

fn parse_stream_line(bytes: &[u8]) -> Option<StreamItem> {
    let line = String::from_utf8_lossy(bytes);
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    let message = value.as_object()?;
    if let Some(error) = message.get("error") {
        let error = match object(error, "event error") {
            Ok(error) => error,
            Err(reason) => return Some(StreamItem::ServerError(reason)),
        };
        let code = required_string(error, "code", "error.code")
            .unwrap_or_else(|_| "protocol_error".to_owned());
        let message = required_string(error, "message", "error.message")
            .unwrap_or_else(|_| "Herdr event subscription failed".to_owned());
        return Some(StreamItem::ServerError(if message.is_empty() {
            code
        } else {
            message
        }));
    }
    let (raw_event, data) = match message.get("event") {
        Some(Value::String(event)) => (event.as_str(), message.get("data").unwrap_or(&Value::Null)),
        Some(Value::Object(event)) => match event.get("event") {
            Some(Value::String(kind)) => (kind.as_str(), event.get("data").unwrap_or(&Value::Null)),
            _ => return None,
        },
        _ => return None,
    };
    Some(StreamItem::Event(Box::new(decode_event(raw_event, data))))
}

fn normalize_event_name(raw_event: &str) -> Option<String> {
    let event = if raw_event.contains('.') {
        raw_event.to_owned()
    } else {
        raw_event.replacen('_', ".", 1)
    };
    EVENT_NAMES.contains(&event.as_str()).then_some(event)
}

fn decode_event(raw_event: &str, value: &Value) -> HerdrEvent {
    let Some(kind) = normalize_event_name(raw_event) else {
        return HerdrEvent::ProtocolUnknown {
            raw_event: raw_event.to_owned(),
        };
    };
    match decode_known_event(&kind, value) {
        Ok(event) => event,
        Err(reason) => HerdrEvent::ProtocolInvalid {
            raw_event: raw_event.to_owned(),
            reason,
        },
    }
}

fn validate_discriminator(data: &Map<String, Value>, kind: &str) -> Result<(), String> {
    let Some(value) = data.get("type") else {
        return Ok(());
    };
    let expected = kind.replacen('.', "_", 1);
    if value.as_str() == Some(expected.as_str()) {
        Ok(())
    } else {
        Err(format!("type must be {expected}"))
    }
}

fn optional_decoded<T>(
    data: &Map<String, Value>,
    key: &str,
    label: &str,
    decode: impl FnOnce(&Value, &str) -> Result<T, String>,
) -> Result<Option<T>, String> {
    data.get(key).map(|value| decode(value, label)).transpose()
}

fn required_id(data: &Map<String, Value>, key: &str) -> Result<String, String> {
    non_empty_string_value(required(data, key, key)?, key)
}

fn decoded_array<T>(
    value: &Value,
    label: &str,
    decode: impl Fn(&Value, &str) -> Result<T, String>,
) -> Result<Vec<T>, String> {
    value
        .as_array()
        .ok_or_else(|| format!("{label} must be an array"))?
        .iter()
        .enumerate()
        .map(|(index, value)| decode(value, &format!("{label}[{index}]")))
        .collect()
}

fn decode_known_event(kind: &str, value: &Value) -> Result<HerdrEvent, String> {
    let data = object(value, "event data")?;
    validate_discriminator(data, kind)?;
    Ok(match kind {
        "workspace.created" => HerdrEvent::WorkspaceCreated {
            workspace: workspace(required(data, "workspace", "workspace")?, "workspace")?,
        },
        "workspace.updated" => HerdrEvent::WorkspaceUpdated {
            workspace: workspace(required(data, "workspace", "workspace")?, "workspace")?,
        },
        "workspace.metadata_updated" => HerdrEvent::WorkspaceMetadataUpdated {
            workspace: workspace(required(data, "workspace", "workspace")?, "workspace")?,
        },
        "workspace.closed" => HerdrEvent::WorkspaceClosed {
            workspace_id: required_id(data, "workspace_id")?,
            workspace: optional_decoded(data, "workspace", "workspace", workspace)?,
        },
        "workspace.renamed" => HerdrEvent::WorkspaceRenamed {
            workspace_id: required_id(data, "workspace_id")?,
            label: required_string(data, "label", "label")?,
        },
        "workspace.moved" => HerdrEvent::WorkspaceMoved {
            workspace_id: required_id(data, "workspace_id")?,
            insert_index: non_negative_number(
                required(data, "insert_index", "insert_index")?,
                "insert_index",
            )?,
            workspaces: decoded_array(
                required(data, "workspaces", "workspaces")?,
                "workspaces",
                workspace,
            )?,
        },
        "workspace.reordered" => HerdrEvent::WorkspaceReordered {
            workspace_ids: string_array(
                required(data, "workspace_ids", "workspace_ids")?,
                "workspace_ids",
            )?
            .into_iter()
            .enumerate()
            .map(|(index, id)| {
                if id.is_empty() {
                    Err(format!("workspace_ids[{index}] must not be empty"))
                } else {
                    Ok(id)
                }
            })
            .collect::<Result<Vec<_>, _>>()?,
            workspaces: decoded_array(
                required(data, "workspaces", "workspaces")?,
                "workspaces",
                workspace,
            )?,
            before_workspace_id: optional_string(
                data,
                "before_workspace_id",
                "before_workspace_id",
            )?,
        },
        "workspace.focused" => HerdrEvent::WorkspaceFocused {
            workspace_id: required_id(data, "workspace_id")?,
        },
        "worktree.created" => HerdrEvent::WorktreeCreated {
            workspace: workspace(required(data, "workspace", "workspace")?, "workspace")?,
            worktree: worktree(required(data, "worktree", "worktree")?, "worktree")?,
        },
        "worktree.opened" => HerdrEvent::WorktreeOpened {
            workspace: workspace(required(data, "workspace", "workspace")?, "workspace")?,
            worktree: worktree(required(data, "worktree", "worktree")?, "worktree")?,
            already_open: bool_value(
                required(data, "already_open", "already_open")?,
                "already_open",
            )?,
        },
        "worktree.removed" => HerdrEvent::WorktreeRemoved {
            workspace_id: required_id(data, "workspace_id")?,
            workspace: optional_decoded(data, "workspace", "workspace", workspace)?,
            worktree: worktree(required(data, "worktree", "worktree")?, "worktree")?,
            forced: bool_value(required(data, "forced", "forced")?, "forced")?,
        },
        "tab.created" => HerdrEvent::TabCreated {
            tab: tab(required(data, "tab", "tab")?, "tab")?,
        },
        "tab.closed" => HerdrEvent::TabClosed {
            workspace_id: required_id(data, "workspace_id")?,
            tab_id: required_id(data, "tab_id")?,
        },
        "tab.focused" => HerdrEvent::TabFocused {
            workspace_id: required_id(data, "workspace_id")?,
            tab_id: required_id(data, "tab_id")?,
        },
        "tab.renamed" => HerdrEvent::TabRenamed {
            workspace_id: required_id(data, "workspace_id")?,
            tab_id: required_id(data, "tab_id")?,
            label: required_string(data, "label", "label")?,
        },
        "tab.moved" => HerdrEvent::TabMoved {
            workspace_id: required_id(data, "workspace_id")?,
            tab_id: required_id(data, "tab_id")?,
            insert_index: non_negative_number(
                required(data, "insert_index", "insert_index")?,
                "insert_index",
            )?,
            tabs: decoded_array(required(data, "tabs", "tabs")?, "tabs", tab)?,
        },
        "pane.created" => HerdrEvent::PaneCreated {
            pane: pane(required(data, "pane", "pane")?, "pane")?,
        },
        "pane.updated" => HerdrEvent::PaneUpdated {
            pane: pane(required(data, "pane", "pane")?, "pane")?,
        },
        "pane.closed" => HerdrEvent::PaneClosed {
            workspace_id: required_id(data, "workspace_id")?,
            pane_id: required_id(data, "pane_id")?,
        },
        "pane.focused" => HerdrEvent::PaneFocused {
            workspace_id: required_id(data, "workspace_id")?,
            pane_id: required_id(data, "pane_id")?,
        },
        "pane.exited" => HerdrEvent::PaneExited {
            workspace_id: required_id(data, "workspace_id")?,
            pane_id: required_id(data, "pane_id")?,
        },
        "pane.moved" => HerdrEvent::PaneMoved {
            previous_pane_id: required_id(data, "previous_pane_id")?,
            previous_workspace_id: required_id(data, "previous_workspace_id")?,
            previous_tab_id: required_id(data, "previous_tab_id")?,
            pane: pane(required(data, "pane", "pane")?, "pane")?,
            created_workspace: optional_decoded(
                data,
                "created_workspace",
                "created_workspace",
                workspace,
            )?,
            created_tab: optional_decoded(data, "created_tab", "created_tab", tab)?,
            closed_workspace_id: optional_string(
                data,
                "closed_workspace_id",
                "closed_workspace_id",
            )?,
            closed_tab_id: optional_string(data, "closed_tab_id", "closed_tab_id")?,
        },
        "pane.output_changed" => HerdrEvent::PaneOutputChanged {
            workspace_id: required_id(data, "workspace_id")?,
            pane_id: required_id(data, "pane_id")?,
            revision: non_negative_number(required(data, "revision", "revision")?, "revision")?,
        },
        "pane.agent_detected" => HerdrEvent::PaneAgentDetected {
            workspace_id: required_id(data, "workspace_id")?,
            pane_id: required_id(data, "pane_id")?,
            agent: optional_string(data, "agent", "agent")?,
            released: match data.get("released") {
                Some(value) => bool_value(value, "released")?,
                None => false,
            },
            final_status: data
                .get("final_status")
                .map(|value| agent_status(value, "final_status"))
                .transpose()?,
        },
        "pane.agent_status_changed" => HerdrEvent::PaneAgentStatusChanged {
            workspace_id: required_id(data, "workspace_id")?,
            pane_id: required_id(data, "pane_id")?,
            agent_status: agent_status(
                required(data, "agent_status", "agent_status")?,
                "agent_status",
            )?,
            agent: optional_string(data, "agent", "agent")?,
            title: optional_string(data, "title", "title")?,
            display_agent: optional_string(data, "display_agent", "display_agent")?,
            state_labels: data
                .get("state_labels")
                .map(|value| string_map(value, "state_labels"))
                .transpose()?,
        },
        "layout.updated" => HerdrEvent::LayoutUpdated {
            layout: pane_layout(required(data, "layout", "layout")?, "layout")?,
        },
        _ => return Err(format!("unsupported known event {kind}")),
    })
}

#[derive(Serialize)]
struct SubscribeRequest<'a> {
    id: &'a str,
    method: &'a str,
    params: SubscribeParams,
}

#[derive(Serialize)]
struct SubscribeParams {
    subscriptions: Vec<Subscription>,
}

#[derive(Serialize)]
struct Subscription {
    #[serde(rename = "type")]
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pane_id: Option<String>,
}

fn subscription_request(protocol: u32, pane_ids: &[String]) -> Result<Vec<u8>, HerdrEventError> {
    herdr_codec::validate_protocol(protocol)
        .map_err(|error| HerdrEventError::UnsupportedProtocol(error.to_string()))?;
    let mut subscriptions = LIFECYCLE_SUBSCRIPTIONS
        .iter()
        .filter(|kind| protocol != 17 || **kind != "workspace.reordered")
        .map(|kind| Subscription {
            kind: (*kind).to_owned(),
            pane_id: None,
        })
        .collect::<Vec<_>>();
    let mut pane_ids = pane_ids.to_vec();
    pane_ids.sort();
    pane_ids.dedup();
    subscriptions.extend(pane_ids.into_iter().map(|pane_id| Subscription {
        kind: "pane.agent_status_changed".to_owned(),
        pane_id: Some(pane_id),
    }));
    let mut bytes = serde_json::to_vec(&SubscribeRequest {
        id: "android_events",
        method: "events.subscribe",
        params: SubscribeParams { subscriptions },
    })
    .map_err(|error| {
        HerdrEventError::SubscriptionUnavailable(format!(
            "failed to serialize event subscription: {error}"
        ))
    })?;
    bytes.push(b'\n');
    Ok(bytes)
}

struct EventSubscription {
    id: u64,
    client_key: String,
    channel_id: String,
    parser: Mutex<JsonlEventParser>,
    opened: Mutex<Option<oneshot::Sender<Result<(), HerdrEventError>>>>,
}

#[derive(Default)]
struct Registry {
    by_id: HashMap<u64, Arc<EventSubscription>>,
    by_client: HashMap<String, u64>,
}

static NEXT_SUBSCRIPTION_ID: AtomicU64 = AtomicU64::new(1);
static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
static EVENT_SINK: OnceLock<RwLock<Option<Arc<dyn HerdrEventSink>>>> = OnceLock::new();

fn registry() -> &'static Mutex<Registry> {
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}
fn event_sink() -> &'static RwLock<Option<Arc<dyn HerdrEventSink>>> {
    EVENT_SINK.get_or_init(|| RwLock::new(None))
}
fn subscription(id: u64) -> Option<Arc<EventSubscription>> {
    registry().lock().by_id.get(&id).cloned()
}

fn remove_subscription(id: u64) {
    let mut registry = registry().lock();
    registry.by_client.retain(|_, current| *current != id);
    registry.by_id.remove(&id);
}

fn c_error(error: *const c_char) -> Option<String> {
    (!error.is_null()).then(|| {
        unsafe { CStr::from_ptr(error) }
            .to_string_lossy()
            .into_owned()
    })
}

unsafe extern "C" fn transport_opened(id: u64, error: *const c_char) {
    let Some(subscription) = subscription(id) else {
        return;
    };
    let result = c_error(error)
        .map(|message| Err(HerdrEventError::TransportDisconnected(message)))
        .unwrap_or(Ok(()));
    if let Some(sender) = subscription.opened.lock().take() {
        let _ = sender.send(result);
    }
}

unsafe extern "C" fn transport_frame(id: u64, bytes: *const u8, length: usize) {
    let Some(subscription) = subscription(id) else {
        return;
    };
    if bytes.is_null() && length != 0 {
        fail_subscription(
            &subscription,
            "native SSH transport delivered null event bytes".to_owned(),
        );
        return;
    }
    let bytes = if length == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(bytes, length) }
    };
    let items = subscription.parser.lock().push(bytes);
    for item in items {
        match item {
            StreamItem::Event(event) => {
                let event = *event;
                if !crate::host_runtime::deliver_herdr_event(
                    &subscription.client_key,
                    event.clone(),
                ) && let Some(sink) = event_sink().read().clone()
                {
                    sink.event(subscription.client_key.clone(), event);
                }
            }
            StreamItem::ServerError(reason) => {
                fail_subscription(&subscription, reason);
                break;
            }
        }
    }
}

unsafe extern "C" fn transport_closed(id: u64, reason: *const c_char) {
    let Some(subscription) = subscription(id) else {
        return;
    };
    subscription.parser.lock().end();
    if let Some(sender) = subscription.opened.lock().take() {
        let _ = sender.send(Err(HerdrEventError::TransportDisconnected(
            c_error(reason)
                .unwrap_or_else(|| "Herdr event subscription closed during startup".to_owned()),
        )));
    } else {
        let reason =
            c_error(reason).unwrap_or_else(|| "Herdr event subscription closed".to_owned());
        if !crate::host_runtime::event_subscription_closed(&subscription.client_key, reason.clone())
            && let Some(sink) = event_sink().read().clone()
        {
            sink.closed(subscription.client_key.clone(), reason);
        }
    }
    remove_subscription(id);
}

fn fail_subscription(subscription: &EventSubscription, reason: String) {
    if !crate::host_runtime::event_subscription_closed(&subscription.client_key, reason.clone())
        && let Some(sink) = event_sink().read().clone()
    {
        sink.closed(subscription.client_key.clone(), reason);
    }
    let _ = russh_transport::close(&subscription.client_key, &subscription.channel_id);
    remove_subscription(subscription.id);
}

pub(crate) async fn start_on_runtime(
    client_key: String,
    socket_path: String,
    protocol: u32,
    pane_ids: Vec<String>,
) -> Result<(), HerdrEventError> {
    if registry().lock().by_client.contains_key(&client_key) {
        return Ok(());
    }
    let request = subscription_request(protocol, &pane_ids)?;
    let id = NEXT_SUBSCRIPTION_ID.fetch_add(1, Ordering::Relaxed);
    let channel_id = format!("whip-herdr-events-{id}");
    let (opened_sender, opened_receiver) = oneshot::channel();
    let subscription = Arc::new(EventSubscription {
        id,
        client_key: client_key.clone(),
        channel_id: channel_id.clone(),
        parser: Mutex::new(JsonlEventParser::default()),
        opened: Mutex::new(Some(opened_sender)),
    });
    {
        let mut registry = registry().lock();
        registry.by_id.insert(id, subscription.clone());
        registry.by_client.insert(client_key.clone(), id);
    }
    if let Err(error) = russh_transport::open_raw(
        id,
        &client_key,
        &channel_id,
        &socket_path,
        EVENT_READ_CHUNK_BYTES,
        transport_opened,
        transport_frame,
        transport_closed,
    ) {
        remove_subscription(id);
        return Err(HerdrEventError::TransportDisconnected(error));
    }
    match opened_receiver.await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            remove_subscription(id);
            return Err(error);
        }
        Err(_) => {
            remove_subscription(id);
            return Err(HerdrEventError::SubscriptionUnavailable(
                "Herdr event transport did not finish opening".to_owned(),
            ));
        }
    }
    if let Err(error) = russh_transport::write_raw(&client_key, &channel_id, &request) {
        let _ = russh_transport::close(&client_key, &channel_id);
        remove_subscription(id);
        return Err(HerdrEventError::TransportDisconnected(error));
    }
    Ok(())
}

#[uniffi::export]
pub fn set_herdr_event_sink(sink: Arc<dyn HerdrEventSink>) {
    *event_sink().write() = Some(sink);
}

#[uniffi::export]
pub fn clear_herdr_event_sink() {
    *event_sink().write() = None;
}

#[uniffi::export]
pub async fn start_herdr_event_subscription(
    client_key: String,
    socket_path: String,
    protocol: u32,
    pane_ids: Vec<String>,
) -> Result<(), HerdrEventError> {
    let runtime = crate::runtime().map_err(HerdrEventError::TransportDisconnected)?;
    runtime
        .spawn(start_on_runtime(
            client_key,
            socket_path,
            protocol,
            pane_ids,
        ))
        .await
        .map_err(|error| {
            HerdrEventError::SubscriptionUnavailable(format!(
                "Herdr event runtime task failed: {error}"
            ))
        })?
}

#[uniffi::export]
pub fn close_herdr_event_subscription(client_key: String) {
    let subscription = {
        let registry = registry().lock();
        registry
            .by_client
            .get(&client_key)
            .and_then(|id| registry.by_id.get(id))
            .cloned()
    };
    if let Some(subscription) = subscription {
        remove_subscription(subscription.id);
        let _ = russh_transport::close(&subscription.client_key, &subscription.channel_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event_kind(event: &HerdrEvent) -> &'static str {
        match event {
            HerdrEvent::WorkspaceCreated { .. } => "workspace.created",
            HerdrEvent::WorkspaceUpdated { .. } => "workspace.updated",
            HerdrEvent::WorkspaceMetadataUpdated { .. } => "workspace.metadata_updated",
            HerdrEvent::WorkspaceClosed { .. } => "workspace.closed",
            HerdrEvent::WorkspaceRenamed { .. } => "workspace.renamed",
            HerdrEvent::WorkspaceMoved { .. } => "workspace.moved",
            HerdrEvent::WorkspaceReordered { .. } => "workspace.reordered",
            HerdrEvent::WorkspaceFocused { .. } => "workspace.focused",
            HerdrEvent::WorktreeCreated { .. } => "worktree.created",
            HerdrEvent::WorktreeOpened { .. } => "worktree.opened",
            HerdrEvent::WorktreeRemoved { .. } => "worktree.removed",
            HerdrEvent::TabCreated { .. } => "tab.created",
            HerdrEvent::TabClosed { .. } => "tab.closed",
            HerdrEvent::TabFocused { .. } => "tab.focused",
            HerdrEvent::TabRenamed { .. } => "tab.renamed",
            HerdrEvent::TabMoved { .. } => "tab.moved",
            HerdrEvent::PaneCreated { .. } => "pane.created",
            HerdrEvent::PaneUpdated { .. } => "pane.updated",
            HerdrEvent::PaneClosed { .. } => "pane.closed",
            HerdrEvent::PaneFocused { .. } => "pane.focused",
            HerdrEvent::PaneExited { .. } => "pane.exited",
            HerdrEvent::PaneMoved { .. } => "pane.moved",
            HerdrEvent::PaneOutputChanged { .. } => "pane.output_changed",
            HerdrEvent::PaneAgentDetected { .. } => "pane.agent_detected",
            HerdrEvent::PaneAgentStatusChanged { .. } => "pane.agent_status_changed",
            HerdrEvent::LayoutUpdated { .. } => "layout.updated",
            HerdrEvent::ProtocolUnknown { .. } => "protocol.unknown",
            HerdrEvent::ProtocolInvalid { .. } => "protocol.invalid",
        }
    }

    fn events(items: Vec<StreamItem>) -> Vec<HerdrEvent> {
        items
            .into_iter()
            .filter_map(|item| match item {
                StreamItem::Event(event) => Some(*event),
                StreamItem::ServerError(_) => None,
            })
            .collect()
    }

    fn workspace_fixture() -> Value {
        serde_json::json!({
            "workspace_id": "w1", "number": 1, "label": "work", "focused": true,
            "pane_count": 1, "tab_count": 1, "active_tab_id": "t1", "agent_status": "idle"
        })
    }

    fn worktree_fixture() -> Value {
        serde_json::json!({
            "branch": "main", "is_bare": false, "is_detached": false,
            "is_linked_worktree": true, "is_prunable": false, "label": "work", "path": "/repo"
        })
    }

    fn tab_fixture() -> Value {
        serde_json::json!({
            "tab_id": "t1", "workspace_id": "w1", "number": 1, "label": "shell",
            "focused": true, "pane_count": 1, "agent_status": "idle"
        })
    }

    fn pane_fixture() -> Value {
        serde_json::json!({
            "pane_id": "p1", "terminal_id": "term1", "workspace_id": "w1", "tab_id": "t1",
            "focused": true, "agent_status": "idle", "revision": 1
        })
    }

    fn layout_fixture() -> Value {
        serde_json::json!({
            "workspace_id": "w1", "tab_id": "t1", "zoomed": false,
            "area": {"x": 0, "y": 0, "width": 80, "height": 24},
            "focused_pane_id": "p1",
            "panes": [{
                "pane_id": "p1", "focused": true,
                "rect": {"x": 0, "y": 0, "width": 80, "height": 24}
            }],
            "splits": []
        })
    }

    #[test]
    fn every_supported_event_kind_decodes_to_its_typed_variant() {
        let workspace = workspace_fixture();
        let worktree = worktree_fixture();
        let tab = tab_fixture();
        let pane = pane_fixture();
        let layout = layout_fixture();
        let fixtures = vec![
            (
                "workspace.created",
                serde_json::json!({"workspace": workspace}),
            ),
            (
                "workspace.updated",
                serde_json::json!({"workspace": workspace}),
            ),
            (
                "workspace.metadata_updated",
                serde_json::json!({"workspace": workspace}),
            ),
            (
                "workspace.closed",
                serde_json::json!({"workspace_id": "w1", "workspace": workspace}),
            ),
            (
                "workspace.renamed",
                serde_json::json!({"workspace_id": "w1", "label": "new"}),
            ),
            (
                "workspace.moved",
                serde_json::json!({"workspace_id": "w1", "insert_index": 0, "workspaces": [workspace]}),
            ),
            (
                "workspace.reordered",
                serde_json::json!({"workspace_ids": ["w1"], "workspaces": [workspace]}),
            ),
            (
                "workspace.focused",
                serde_json::json!({"workspace_id": "w1"}),
            ),
            (
                "worktree.created",
                serde_json::json!({"workspace": workspace, "worktree": worktree}),
            ),
            (
                "worktree.opened",
                serde_json::json!({"workspace": workspace, "worktree": worktree, "already_open": false}),
            ),
            (
                "worktree.removed",
                serde_json::json!({"workspace_id": "w1", "worktree": worktree, "forced": true}),
            ),
            ("tab.created", serde_json::json!({"tab": tab})),
            (
                "tab.closed",
                serde_json::json!({"workspace_id": "w1", "tab_id": "t1"}),
            ),
            (
                "tab.focused",
                serde_json::json!({"workspace_id": "w1", "tab_id": "t1"}),
            ),
            (
                "tab.renamed",
                serde_json::json!({"workspace_id": "w1", "tab_id": "t1", "label": "new"}),
            ),
            (
                "tab.moved",
                serde_json::json!({"workspace_id": "w1", "tab_id": "t1", "insert_index": 0, "tabs": [tab]}),
            ),
            ("pane.created", serde_json::json!({"pane": pane})),
            ("pane.updated", serde_json::json!({"pane": pane})),
            (
                "pane.closed",
                serde_json::json!({"workspace_id": "w1", "pane_id": "p1"}),
            ),
            (
                "pane.focused",
                serde_json::json!({"workspace_id": "w1", "pane_id": "p1"}),
            ),
            (
                "pane.exited",
                serde_json::json!({"workspace_id": "w1", "pane_id": "p1"}),
            ),
            (
                "pane.moved",
                serde_json::json!({
                    "previous_pane_id": "p0", "previous_workspace_id": "w0", "previous_tab_id": "t0", "pane": pane
                }),
            ),
            (
                "pane.output_changed",
                serde_json::json!({"workspace_id": "w1", "pane_id": "p1", "revision": 2}),
            ),
            (
                "pane.agent_detected",
                serde_json::json!({"workspace_id": "w1", "pane_id": "p1"}),
            ),
            (
                "pane.agent_status_changed",
                serde_json::json!({
                    "workspace_id": "w1", "pane_id": "p1", "agent_status": "working"
                }),
            ),
            ("layout.updated", serde_json::json!({"layout": layout})),
        ];
        assert_eq!(fixtures.len(), EVENT_NAMES.len());
        for (kind, data) in fixtures {
            let decoded = decode_event(kind, &data);
            assert_eq!(event_kind(&decoded), kind, "failed to decode {kind}");
        }
    }

    #[test]
    fn subscription_request_matches_typescript_and_protocol_17_difference() {
        let line = String::from_utf8(
            subscription_request(20, &["w1:p2".into(), "w1:p1".into(), "w1:p2".into()]).unwrap(),
        )
        .unwrap();
        assert!(line.starts_with("{\"id\":\"android_events\",\"method\":\"events.subscribe\",\"params\":{\"subscriptions\":[{\"type\":\"workspace.created\"}"));
        assert!(line.contains("{\"type\":\"workspace.reordered\"}"));
        assert!(line.ends_with("{\"type\":\"pane.agent_status_changed\",\"pane_id\":\"w1:p1\"},{\"type\":\"pane.agent_status_changed\",\"pane_id\":\"w1:p2\"}]}}\n"));
        let v17 = String::from_utf8(subscription_request(17, &[]).unwrap()).unwrap();
        assert!(!v17.contains("workspace.reordered"));
    }

    #[test]
    fn frames_complete_multiple_fragmented_blank_and_crlf_lines() {
        let mut parser = JsonlEventParser::default();
        assert!(
            parser
                .push(br#"{"event":"tab.focused","data":{"workspace_id":"w1","tab_id":"t"#)
                .is_empty()
        );
        let parsed = events(parser.push(b"2"));
        assert!(parsed.is_empty());
        let parsed = events(parser.push(b"\"}}\r\n\n{\"event\":\"pane.focused\",\"data\":{\"workspace_id\":\"w1\",\"pane_id\":\"p2\"}}\n"));
        assert_eq!(parsed.len(), 2);
        assert_eq!(event_kind(&parsed[0]), "tab.focused");
        assert_eq!(event_kind(&parsed[1]), "pane.focused");
    }

    #[test]
    fn parser_reset_drops_partial_previous_subscription() {
        let mut first = JsonlEventParser::default();
        assert!(first.push(br#"{"event":"tab.focused""#).is_empty());
        first.end();
        let mut next = JsonlEventParser::default();
        let parsed = events(next.push(
            b"{\"event\":\"pane.focused\",\"data\":{\"workspace_id\":\"w1\",\"pane_id\":\"p1\"}}\n",
        ));
        assert_eq!(parsed.len(), 1);
        assert_eq!(event_kind(&parsed[0]), "pane.focused");
    }

    #[test]
    fn direct_legacy_and_underscore_envelopes_normalize_identically() {
        let direct = parse_stream_line(
            br#"{"event":"pane.focused","data":{"workspace_id":"w1","pane_id":"p1"}}"#,
        )
        .unwrap();
        let legacy = parse_stream_line(br#"{"subscription_id":"events","event":{"event":"pane_focused","data":{"workspace_id":"w1","pane_id":"p1"}}}"#).unwrap();
        let StreamItem::Event(direct) = direct else {
            panic!("event")
        };
        let StreamItem::Event(legacy) = legacy else {
            panic!("event")
        };
        assert_eq!(direct, legacy);
    }

    #[test]
    fn unknown_and_malformed_known_events_are_distinct() {
        assert!(matches!(
            decode_event("future.created", &serde_json::json!({})),
            HerdrEvent::ProtocolUnknown { raw_event } if raw_event == "future.created"
        ));
        let invalid = decode_event("tab.focused", &Value::Null);
        assert!(matches!(
            invalid,
            HerdrEvent::ProtocolInvalid { reason, .. }
                if reason == "event data must be an object"
        ));
    }

    #[test]
    fn agent_focus_layout_and_nested_validation_match_typescript() {
        let agent = decode_event(
            "pane.agent_status_changed",
            &serde_json::json!({
                "workspace_id":"w1", "pane_id":"p1", "agent_status":"done", "state_labels":{"phase":"review"}
            }),
        );
        let HerdrEvent::PaneAgentStatusChanged {
            agent_status,
            state_labels,
            ..
        } = agent
        else {
            panic!("agent status event")
        };
        assert_eq!(agent_status, "done");
        assert_eq!(
            state_labels.unwrap().get("phase").map(String::as_str),
            Some("review")
        );
        let invalid_layout = decode_event(
            "layout.updated",
            &serde_json::json!({"layout":{"workspace_id":"w1"}}),
        );
        assert!(matches!(invalid_layout, HerdrEvent::ProtocolInvalid { .. }));
        let invalid_pane = decode_event(
            "pane.updated",
            &serde_json::json!({"pane":{"pane_id":"p1"}}),
        );
        assert!(matches!(
            invalid_pane,
            HerdrEvent::ProtocolInvalid { reason, .. }
                if reason.contains("pane.terminal_id")
        ));
    }

    #[test]
    fn malformed_json_and_invalid_utf8_do_not_stop_later_events() {
        let mut parser = JsonlEventParser::default();
        let mut bytes = b"not-json\n{\"event\":\"future.created\",\"data\":{\"label\":\"".to_vec();
        bytes.push(0xff);
        bytes.extend_from_slice(
            b"\"}}\n{\"event\":\"workspace.focused\",\"data\":{\"workspace_id\":\"w1\"}}\n",
        );
        let parsed = events(parser.push(&bytes));
        assert_eq!(parsed.last().map(event_kind), Some("workspace.focused"));
    }

    #[test]
    fn oversized_line_is_reported_and_parser_recovers() {
        let mut parser = JsonlEventParser::default();
        let mut input = vec![b'x'; MAX_EVENT_LINE_BYTES + 1];
        input.extend_from_slice(
            b"\n{\"event\":\"workspace.focused\",\"data\":{\"workspace_id\":\"w1\"}}\n",
        );
        let parsed = events(parser.push(&input));
        assert_eq!(event_kind(&parsed[0]), "protocol.invalid");
        assert_eq!(event_kind(&parsed[1]), "workspace.focused");
    }

    #[test]
    fn arbitrary_malformed_values_never_panic() {
        for value in [
            Value::Null,
            Value::Bool(true),
            serde_json::json!([]),
            serde_json::json!({"type": 1}),
        ] {
            let event = decode_event("pane.agent_status_changed", &value);
            assert_eq!(event_kind(&event), "protocol.invalid");
        }
    }
}
