//! Typed Herdr control API requests, responses, and shared domain validation.

use std::collections::HashMap;
use std::ffi::{CStr, c_char};
use std::sync::{
    OnceLock,
    atomic::{AtomicU64, Ordering},
};

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Map, Value};
use tokio::sync::oneshot;

use crate::russh_transport;

const CONTROL_TIMEOUT_MS: u64 = 15_000;
const MAX_CONTROL_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HerdrAgentSessionInfo {
    pub source: String,
    pub agent: String,
    pub kind: String,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HerdrPaneScrollInfo {
    pub offset_from_bottom: f64,
    pub max_offset_from_bottom: f64,
    pub viewport_rows: f64,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HerdrWorkspaceWorktreeInfo {
    pub repo_key: String,
    pub repo_name: String,
    pub repo_root: String,
    pub checkout_path: String,
    pub is_linked_worktree: bool,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HerdrWorkspaceInfo {
    pub workspace_id: String,
    pub number: f64,
    pub label: String,
    pub focused: bool,
    pub pane_count: f64,
    pub tab_count: f64,
    pub active_tab_id: String,
    pub agent_status: String,
    pub tokens: Option<HashMap<String, String>>,
    pub worktree: Option<HerdrWorkspaceWorktreeInfo>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HerdrWorktreeInfo {
    pub branch: Option<String>,
    pub is_bare: bool,
    pub is_detached: bool,
    pub is_linked_worktree: bool,
    pub is_prunable: bool,
    pub label: String,
    pub open_workspace_id: Option<String>,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HerdrTabInfo {
    pub tab_id: String,
    pub workspace_id: String,
    pub number: f64,
    pub label: String,
    pub focused: bool,
    pub pane_count: f64,
    pub agent_status: String,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HerdrPaneInfo {
    pub pane_id: String,
    pub terminal_id: String,
    pub workspace_id: String,
    pub tab_id: String,
    pub focused: bool,
    pub cwd: Option<String>,
    pub foreground_cwd: Option<String>,
    pub label: Option<String>,
    pub agent: Option<String>,
    pub title: Option<String>,
    pub terminal_title: Option<String>,
    pub terminal_title_stripped: Option<String>,
    pub display_agent: Option<String>,
    pub agent_status: String,
    pub state_labels: Option<HashMap<String, String>>,
    pub tokens: Option<HashMap<String, String>>,
    pub agent_session: Option<HerdrAgentSessionInfo>,
    pub scroll: Option<HerdrPaneScrollInfo>,
    pub revision: f64,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HerdrAgentInfo {
    pub pane_id: String,
    pub terminal_id: String,
    pub workspace_id: String,
    pub tab_id: String,
    pub focused: bool,
    pub agent_status: String,
    pub revision: f64,
    pub cwd: Option<String>,
    pub foreground_cwd: Option<String>,
    pub agent: Option<String>,
    pub name: Option<String>,
    pub title: Option<String>,
    pub terminal_title: Option<String>,
    pub terminal_title_stripped: Option<String>,
    pub display_agent: Option<String>,
    pub interactive_ready: Option<bool>,
    pub launch_pending: Option<bool>,
    pub screen_detection_skipped: Option<bool>,
    pub state_change_seq: Option<f64>,
    pub state_labels: Option<HashMap<String, String>>,
    pub tokens: Option<HashMap<String, String>>,
    pub agent_session: Option<HerdrAgentSessionInfo>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HerdrPaneLayoutRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HerdrPaneLayoutPane {
    pub pane_id: String,
    pub focused: bool,
    pub rect: HerdrPaneLayoutRect,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HerdrPaneLayoutSplit {
    pub id: String,
    pub direction: String,
    pub ratio: f64,
    pub rect: HerdrPaneLayoutRect,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HerdrPaneLayoutSnapshot {
    pub workspace_id: String,
    pub tab_id: String,
    pub zoomed: bool,
    pub area: HerdrPaneLayoutRect,
    pub focused_pane_id: String,
    pub panes: Vec<HerdrPaneLayoutPane>,
    pub splits: Vec<HerdrPaneLayoutSplit>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HerdrSessionSnapshot {
    pub version: String,
    pub protocol: u32,
    pub focused_workspace_id: Option<String>,
    pub focused_tab_id: Option<String>,
    pub focused_pane_id: Option<String>,
    pub agents: Vec<HerdrAgentInfo>,
    pub workspaces: Vec<HerdrWorkspaceInfo>,
    pub tabs: Vec<HerdrTabInfo>,
    pub panes: Vec<HerdrPaneInfo>,
    pub layouts: Vec<HerdrPaneLayoutSnapshot>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HerdrControlResult {
    pub kind: String,
    pub version: Option<String>,
    pub protocol: Option<u32>,
    pub snapshot: Option<HerdrSessionSnapshot>,
    pub workspace: Option<HerdrWorkspaceInfo>,
    pub tab: Option<HerdrTabInfo>,
    pub pane: Option<HerdrPaneInfo>,
    pub root_pane: Option<HerdrPaneInfo>,
    pub agent: Option<HerdrAgentInfo>,
    pub argv: Option<Vec<String>>,
    pub read_text: Option<String>,
}

impl HerdrControlResult {
    fn empty(kind: &str) -> Self {
        Self {
            kind: kind.to_owned(),
            version: None,
            protocol: None,
            snapshot: None,
            workspace: None,
            tab: None,
            pane: None,
            root_pane: None,
            agent: None,
            argv: None,
            read_text: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum HerdrControlRequest {
    Ping,
    SessionSnapshot,
    WorkspaceCreate {
        label: Option<String>,
        cwd: Option<String>,
    },
    WorkspaceFocus {
        workspace_id: String,
    },
    WorkspaceRename {
        workspace_id: String,
        label: String,
    },
    WorkspaceClose {
        workspace_id: String,
    },
    TabCreate {
        workspace_id: String,
        label: Option<String>,
    },
    TabFocus {
        tab_id: String,
    },
    TabRename {
        tab_id: String,
        label: String,
    },
    TabClose {
        tab_id: String,
    },
    PaneRead {
        pane_id: String,
        lines: u32,
    },
    PaneFocus {
        pane_id: String,
    },
    PaneRename {
        pane_id: String,
        label: Option<String>,
    },
    PaneSplit {
        pane_id: String,
        direction: String,
    },
    PaneZoom {
        pane_id: String,
    },
    PaneClose {
        pane_id: String,
    },
    PaneSendInput {
        pane_id: String,
        text: String,
        keys: Vec<String>,
    },
    PaneSendText {
        pane_id: String,
        text: String,
    },
    PaneSendKeys {
        pane_id: String,
        keys: Vec<String>,
    },
    AgentStart {
        name: String,
        kind: String,
        pane_id: String,
        args: Vec<String>,
    },
    AgentFocus {
        target: String,
    },
    AgentPrompt {
        target: String,
        text: String,
    },
}

#[derive(Clone, Debug, thiserror::Error, uniffi::Error, PartialEq, Eq)]
pub enum HerdrControlError {
    #[error("{0}")]
    TransportDisconnected(String),
    #[error("{0}")]
    MalformedResponse(String),
    #[error("Herdr API error {0}: {1}")]
    ProtocolError(String, String),
    #[error("{0}")]
    UnsupportedResponse(String),
    #[error("{0}")]
    InvalidField(String),
    #[error("{0}")]
    RequestCancelled(String),
    #[error("{0}")]
    RequestTimeout(String),
}

#[derive(Serialize)]
struct WireRequest<'a, P: Serialize> {
    id: &'a str,
    method: &'a str,
    params: P,
}

#[derive(Serialize)]
struct EmptyParams {}

#[derive(Serialize)]
struct WorkspaceCreateParams<'a> {
    label: Option<&'a str>,
    cwd: Option<&'a str>,
    focus: bool,
}

#[derive(Serialize)]
struct WorkspaceTarget<'a> {
    workspace_id: &'a str,
}
#[derive(Serialize)]
struct WorkspaceRenameParams<'a> {
    workspace_id: &'a str,
    label: &'a str,
}
#[derive(Serialize)]
struct TabCreateParams<'a> {
    workspace_id: &'a str,
    label: Option<&'a str>,
    focus: bool,
}
#[derive(Serialize)]
struct TabTarget<'a> {
    tab_id: &'a str,
}
#[derive(Serialize)]
struct TabRenameParams<'a> {
    tab_id: &'a str,
    label: &'a str,
}
#[derive(Serialize)]
struct PaneTarget<'a> {
    pane_id: &'a str,
}
#[derive(Serialize)]
struct PaneRenameParams<'a> {
    pane_id: &'a str,
    label: Option<&'a str>,
}
#[derive(Serialize)]
struct PaneSplitParams<'a> {
    target_pane_id: &'a str,
    direction: &'a str,
    focus: bool,
}
#[derive(Serialize)]
struct PaneZoomParams<'a> {
    pane_id: &'a str,
    mode: &'a str,
}
#[derive(Serialize)]
struct PaneReadParams<'a> {
    pane_id: &'a str,
    source: &'a str,
    lines: u32,
    format: &'a str,
    strip_ansi: bool,
}
#[derive(Serialize)]
struct PaneSendInputParams<'a> {
    pane_id: &'a str,
    text: &'a str,
    keys: &'a [String],
}
#[derive(Serialize)]
struct PaneSendTextParams<'a> {
    pane_id: &'a str,
    text: &'a str,
}
#[derive(Serialize)]
struct PaneSendKeysParams<'a> {
    pane_id: &'a str,
    keys: &'a [String],
}
#[derive(Serialize)]
struct AgentStartParams<'a> {
    name: &'a str,
    kind: &'a str,
    pane_id: &'a str,
    #[serde(skip_serializing_if = "slice_is_empty")]
    args: &'a [String],
}

fn slice_is_empty<T>(value: &&[T]) -> bool {
    value.is_empty()
}
#[derive(Serialize)]
struct AgentPromptParams<'a> {
    target: &'a str,
    text: &'a str,
}

#[derive(Serialize)]
struct AgentTarget<'a> {
    target: &'a str,
}

impl HerdrControlRequest {
    fn method(&self) -> &'static str {
        match self {
            Self::Ping => "ping",
            Self::SessionSnapshot => "session.snapshot",
            Self::WorkspaceCreate { .. } => "workspace.create",
            Self::WorkspaceFocus { .. } => "workspace.focus",
            Self::WorkspaceRename { .. } => "workspace.rename",
            Self::WorkspaceClose { .. } => "workspace.close",
            Self::TabCreate { .. } => "tab.create",
            Self::TabFocus { .. } => "tab.focus",
            Self::TabRename { .. } => "tab.rename",
            Self::TabClose { .. } => "tab.close",
            Self::PaneRead { .. } => "pane.read",
            Self::PaneFocus { .. } => "pane.focus",
            Self::PaneRename { .. } => "pane.rename",
            Self::PaneSplit { .. } => "pane.split",
            Self::PaneZoom { .. } => "pane.zoom",
            Self::PaneClose { .. } => "pane.close",
            Self::PaneSendInput { .. } => "pane.send_input",
            Self::PaneSendText { .. } => "pane.send_text",
            Self::PaneSendKeys { .. } => "pane.send_keys",
            Self::AgentStart { .. } => "agent.start",
            Self::AgentFocus { .. } => "agent.focus",
            Self::AgentPrompt { .. } => "agent.prompt",
        }
    }

    fn encode(&self, id: &str) -> Result<Vec<u8>, HerdrControlError> {
        fn line<P: Serialize>(request: WireRequest<'_, P>) -> Result<Vec<u8>, HerdrControlError> {
            let mut bytes = serde_json::to_vec(&request).map_err(|error| {
                HerdrControlError::InvalidField(format!(
                    "failed to serialize Herdr request: {error}"
                ))
            })?;
            bytes.push(b'\n');
            Ok(bytes)
        }
        let method = self.method();
        match self {
            Self::Ping | Self::SessionSnapshot => line(WireRequest {
                id,
                method,
                params: EmptyParams {},
            }),
            Self::WorkspaceCreate { label, cwd } => line(WireRequest {
                id,
                method,
                params: WorkspaceCreateParams {
                    label: label.as_deref(),
                    cwd: cwd.as_deref(),
                    focus: true,
                },
            }),
            Self::WorkspaceFocus { workspace_id } | Self::WorkspaceClose { workspace_id } => {
                line(WireRequest {
                    id,
                    method,
                    params: WorkspaceTarget { workspace_id },
                })
            }
            Self::WorkspaceRename {
                workspace_id,
                label,
            } => line(WireRequest {
                id,
                method,
                params: WorkspaceRenameParams {
                    workspace_id,
                    label,
                },
            }),
            Self::TabCreate {
                workspace_id,
                label,
            } => line(WireRequest {
                id,
                method,
                params: TabCreateParams {
                    workspace_id,
                    label: label.as_deref(),
                    focus: true,
                },
            }),
            Self::TabFocus { tab_id } | Self::TabClose { tab_id } => line(WireRequest {
                id,
                method,
                params: TabTarget { tab_id },
            }),
            Self::TabRename { tab_id, label } => line(WireRequest {
                id,
                method,
                params: TabRenameParams { tab_id, label },
            }),
            Self::PaneRead { pane_id, lines } => line(WireRequest {
                id,
                method,
                params: PaneReadParams {
                    pane_id,
                    source: "recent",
                    lines: *lines,
                    format: "ansi",
                    strip_ansi: false,
                },
            }),
            Self::PaneFocus { pane_id } | Self::PaneClose { pane_id } => line(WireRequest {
                id,
                method,
                params: PaneTarget { pane_id },
            }),
            Self::PaneRename { pane_id, label } => line(WireRequest {
                id,
                method,
                params: PaneRenameParams {
                    pane_id,
                    label: label.as_deref(),
                },
            }),
            Self::PaneSplit { pane_id, direction } => {
                if direction != "right" && direction != "down" {
                    return Err(HerdrControlError::InvalidField(
                        "pane split direction must be right or down".to_owned(),
                    ));
                }
                line(WireRequest {
                    id,
                    method,
                    params: PaneSplitParams {
                        target_pane_id: pane_id,
                        direction,
                        focus: true,
                    },
                })
            }
            Self::PaneZoom { pane_id } => line(WireRequest {
                id,
                method,
                params: PaneZoomParams {
                    pane_id,
                    mode: "toggle",
                },
            }),
            Self::PaneSendInput {
                pane_id,
                text,
                keys,
            } => line(WireRequest {
                id,
                method,
                params: PaneSendInputParams {
                    pane_id,
                    text,
                    keys,
                },
            }),
            Self::PaneSendText { pane_id, text } => line(WireRequest {
                id,
                method,
                params: PaneSendTextParams { pane_id, text },
            }),
            Self::PaneSendKeys { pane_id, keys } => line(WireRequest {
                id,
                method,
                params: PaneSendKeysParams { pane_id, keys },
            }),
            Self::AgentStart {
                name,
                kind,
                pane_id,
                args,
            } => line(WireRequest {
                id,
                method,
                params: AgentStartParams {
                    name,
                    kind,
                    pane_id,
                    args,
                },
            }),
            Self::AgentFocus { target } => line(WireRequest {
                id,
                method,
                params: AgentTarget { target },
            }),
            Self::AgentPrompt { target, text } => line(WireRequest {
                id,
                method,
                params: AgentPromptParams { target, text },
            }),
        }
    }

    fn expected_result(&self) -> &'static str {
        match self {
            Self::Ping => "pong",
            Self::SessionSnapshot => "session_snapshot",
            Self::WorkspaceCreate { .. } => "workspace_created",
            Self::WorkspaceFocus { .. } | Self::WorkspaceRename { .. } => "workspace_info",
            Self::WorkspaceClose { .. }
            | Self::TabClose { .. }
            | Self::PaneClose { .. }
            | Self::PaneSendInput { .. }
            | Self::PaneSendText { .. }
            | Self::PaneSendKeys { .. } => "ok",
            Self::TabCreate { .. } => "tab_created",
            Self::TabFocus { .. } | Self::TabRename { .. } => "tab_info",
            Self::PaneRead { .. } => "pane_read",
            Self::PaneFocus { .. } | Self::PaneRename { .. } | Self::PaneSplit { .. } => {
                "pane_info"
            }
            Self::PaneZoom { .. } => "pane_zoom",
            Self::AgentStart { .. } => "agent_started",
            Self::AgentFocus { .. } => "agent_info",
            Self::AgentPrompt { .. } => "agent_prompted",
        }
    }
}

static NEXT_REQUEST_CONTEXT: AtomicU64 = AtomicU64::new(1);
static CONTROL_SEQUENCES: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
type PendingRequest = oneshot::Sender<Result<Vec<u8>, String>>;
static PENDING_REQUESTS: OnceLock<Mutex<HashMap<u64, PendingRequest>>> = OnceLock::new();

fn control_sequences() -> &'static Mutex<HashMap<String, u64>> {
    CONTROL_SEQUENCES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pending_requests() -> &'static Mutex<HashMap<u64, PendingRequest>> {
    PENDING_REQUESTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_request_id(client_key: &str) -> String {
    let mut sequences = control_sequences().lock();
    let sequence = sequences.entry(client_key.to_owned()).or_default();
    *sequence += 1;
    format!("android_{sequence}")
}

unsafe extern "C" fn request_finished(
    context: u64,
    bytes: *const u8,
    length: usize,
    error: *const c_char,
) {
    let Some(sender) = pending_requests().lock().remove(&context) else {
        return;
    };
    let result = if !error.is_null() {
        Err(unsafe { CStr::from_ptr(error) }
            .to_string_lossy()
            .into_owned())
    } else if bytes.is_null() && length != 0 {
        Err("native SSH transport returned a null control response".to_owned())
    } else {
        let response = if length == 0 {
            Vec::new()
        } else {
            unsafe { std::slice::from_raw_parts(bytes, length) }.to_vec()
        };
        Ok(response)
    };
    let _ = sender.send(result);
}

fn transport_error(message: String) -> HerdrControlError {
    if message.to_ascii_lowercase().contains("timed out") {
        HerdrControlError::RequestTimeout(message)
    } else {
        HerdrControlError::TransportDisconnected(message)
    }
}

pub(crate) async fn request_on_runtime(
    client_key: String,
    socket_path: String,
    request: HerdrControlRequest,
) -> Result<HerdrControlResult, HerdrControlError> {
    let request_id = next_request_id(&client_key);
    let bytes = request.encode(&request_id)?;
    let context = NEXT_REQUEST_CONTEXT.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = oneshot::channel();
    pending_requests().lock().insert(context, sender);
    if let Err(error) = russh_transport::request(
        context,
        &client_key,
        &socket_path,
        &bytes,
        b'\n',
        CONTROL_TIMEOUT_MS,
        MAX_CONTROL_RESPONSE_BYTES,
        request_finished,
    ) {
        pending_requests().lock().remove(&context);
        return Err(transport_error(error));
    }
    let response = receiver
        .await
        .map_err(|_| {
            HerdrControlError::RequestCancelled("Herdr control request was cancelled".to_owned())
        })?
        .map_err(transport_error)?;
    parse_response(&request, &response)
}

#[uniffi::export]
pub async fn herdr_control_request(
    client_key: String,
    socket_path: String,
    request: HerdrControlRequest,
) -> Result<HerdrControlResult, HerdrControlError> {
    let runtime = crate::runtime().map_err(HerdrControlError::TransportDisconnected)?;
    runtime
        .spawn(request_on_runtime(client_key, socket_path, request))
        .await
        .map_err(|error| {
            HerdrControlError::RequestCancelled(format!(
                "Herdr control runtime task failed: {error}"
            ))
        })?
}

fn parse_response(
    request: &HerdrControlRequest,
    bytes: &[u8],
) -> Result<HerdrControlResult, HerdrControlError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| {
        HerdrControlError::MalformedResponse("Herdr API returned invalid JSON".to_owned())
    })?;
    let message =
        object(&value, "Herdr API response").map_err(HerdrControlError::MalformedResponse)?;
    if let Some(error) = message.get("error") {
        let error =
            object(error, "Herdr API error").map_err(HerdrControlError::MalformedResponse)?;
        let code = required_string(error, "code", "error.code")
            .map_err(HerdrControlError::MalformedResponse)?;
        let message = required_string(error, "message", "error.message")
            .map_err(HerdrControlError::MalformedResponse)?;
        return Err(HerdrControlError::ProtocolError(code, message));
    }
    let result = message.get("result").ok_or_else(|| {
        HerdrControlError::MalformedResponse(
            "Herdr API response did not include a result".to_owned(),
        )
    })?;
    let result = object(result, "result").map_err(HerdrControlError::InvalidField)?;
    let kind =
        required_string(result, "type", "result.type").map_err(HerdrControlError::InvalidField)?;
    let expected = request.expected_result();
    if kind != expected {
        return Err(HerdrControlError::UnsupportedResponse(format!(
            "Herdr API returned {kind} for {}, expected {expected}",
            request.method()
        )));
    }
    decode_result(kind.as_str(), result).map_err(HerdrControlError::InvalidField)
}

fn decode_result(kind: &str, result: &Map<String, Value>) -> Result<HerdrControlResult, String> {
    let mut decoded = HerdrControlResult::empty(kind);
    match kind {
        "pong" => {
            decoded.version = Some(required_string(result, "version", "result.version")?);
            decoded.protocol = Some(required_u32(result, "protocol", "result.protocol")?);
        }
        "session_snapshot" => {
            decoded.snapshot = Some(session_snapshot(required(
                result,
                "snapshot",
                "result.snapshot",
            )?)?);
        }
        "workspace_created" => {
            decoded.workspace = Some(workspace(
                required(result, "workspace", "result.workspace")?,
                "workspace",
            )?);
            decoded.tab = Some(tab(required(result, "tab", "result.tab")?, "tab")?);
            decoded.root_pane = Some(pane(
                required(result, "root_pane", "result.root_pane")?,
                "root_pane",
            )?);
        }
        "workspace_info" => {
            decoded.workspace = Some(workspace(
                required(result, "workspace", "result.workspace")?,
                "workspace",
            )?);
        }
        "tab_created" => {
            decoded.tab = Some(tab(required(result, "tab", "result.tab")?, "tab")?);
            decoded.root_pane = Some(pane(
                required(result, "root_pane", "result.root_pane")?,
                "root_pane",
            )?);
        }
        "tab_info" => decoded.tab = Some(tab(required(result, "tab", "result.tab")?, "tab")?),
        "pane_info" => decoded.pane = Some(pane(required(result, "pane", "result.pane")?, "pane")?),
        "pane_read" => {
            let read = object(required(result, "read", "result.read")?, "read")?;
            non_empty_string_value(required(read, "pane_id", "read.pane_id")?, "read.pane_id")?;
            non_empty_string_value(
                required(read, "workspace_id", "read.workspace_id")?,
                "read.workspace_id",
            )?;
            non_empty_string_value(required(read, "tab_id", "read.tab_id")?, "read.tab_id")?;
            enum_string(
                required(read, "source", "read.source")?,
                "read.source",
                &["visible", "recent", "recent_unwrapped", "detection"],
            )?;
            enum_string(
                required(read, "format", "read.format")?,
                "read.format",
                &["text", "ansi"],
            )?;
            decoded.read_text = Some(string_value(
                required(read, "text", "read.text")?,
                "read.text",
            )?);
            non_negative_number(
                required(read, "revision", "read.revision")?,
                "read.revision",
            )?;
            bool_value(
                required(read, "truncated", "read.truncated")?,
                "read.truncated",
            )?;
        }
        "agent_started" => {
            decoded.agent = Some(agent(required(result, "agent", "result.agent")?, "agent")?);
            decoded.argv = Some(string_array(
                required(result, "argv", "result.argv")?,
                "argv",
            )?);
        }
        "agent_info" => {
            decoded.agent = Some(agent(required(result, "agent", "result.agent")?, "agent")?);
        }
        "agent_prompted" => {
            decoded.agent = Some(agent(required(result, "agent", "result.agent")?, "agent")?);
        }
        "pane_zoom" => validate_pane_zoom(required(result, "zoom", "result.zoom")?)?,
        "ok" => {}
        _ => return Err(format!("unsupported Herdr response type {kind}")),
    }
    Ok(decoded)
}

fn validate_pane_zoom(value: &Value) -> Result<(), String> {
    let item = object(value, "zoom")?;
    for field in ["changed", "zoom_changed", "focus_changed", "zoomed"] {
        bool_value(
            required(item, field, &format!("zoom.{field}"))?,
            &format!("zoom.{field}"),
        )?;
    }
    non_empty_string_value(required(item, "pane_id", "zoom.pane_id")?, "zoom.pane_id")?;
    non_empty_string_value(
        required(item, "focused_pane_id", "zoom.focused_pane_id")?,
        "zoom.focused_pane_id",
    )?;
    if let Some(reason) = item.get("reason") {
        enum_string(
            reason,
            "zoom.reason",
            &["single_pane", "already_zoomed", "already_unzoomed"],
        )?;
    }
    pane_layout(required(item, "layout", "zoom.layout")?, "zoom.layout")?;
    Ok(())
}

pub(crate) fn object<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{label} must be an object"))
}

pub(crate) fn required<'a>(
    item: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<&'a Value, String> {
    item.get(key).ok_or_else(|| format!("{label} is required"))
}

pub(crate) fn string_value(value: &Value, label: &str) -> Result<String, String> {
    value
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("{label} must be a string"))
}

pub(crate) fn non_empty_string_value(value: &Value, label: &str) -> Result<String, String> {
    let value = string_value(value, label)?;
    if value.is_empty() {
        Err(format!("{label} must not be empty"))
    } else {
        Ok(value)
    }
}

pub(crate) fn bool_value(value: &Value, label: &str) -> Result<bool, String> {
    value
        .as_bool()
        .ok_or_else(|| format!("{label} must be a boolean"))
}

pub(crate) fn finite_number(value: &Value, label: &str) -> Result<f64, String> {
    let value = value
        .as_f64()
        .ok_or_else(|| format!("{label} must be a finite number"))?;
    if value.is_finite() {
        Ok(value)
    } else {
        Err(format!("{label} must be a finite number"))
    }
}

pub(crate) fn non_negative_number(value: &Value, label: &str) -> Result<f64, String> {
    let value = finite_number(value, label)?;
    if value < 0.0 {
        Err(format!("{label} must be non-negative"))
    } else {
        Ok(value)
    }
}

pub(crate) fn required_string(
    item: &Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<String, String> {
    string_value(required(item, key, label)?, label)
}

fn required_u32(item: &Map<String, Value>, key: &str, label: &str) -> Result<u32, String> {
    let value = required(item, key, label)?
        .as_u64()
        .ok_or_else(|| format!("{label} must be an unsigned integer"))?;
    u32::try_from(value).map_err(|_| format!("{label} exceeds u32"))
}

pub(crate) fn optional_string(
    item: &Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<Option<String>, String> {
    item.get(key)
        .map(|value| string_value(value, label))
        .transpose()
}

fn optional_bool(
    item: &Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<Option<bool>, String> {
    item.get(key)
        .map(|value| bool_value(value, label))
        .transpose()
}

fn optional_number(
    item: &Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<Option<f64>, String> {
    item.get(key)
        .map(|value| non_negative_number(value, label))
        .transpose()
}

pub(crate) fn string_map(value: &Value, label: &str) -> Result<HashMap<String, String>, String> {
    object(value, label)?
        .iter()
        .map(|(key, value)| {
            string_value(value, &format!("{label}.{key}")).map(|value| (key.clone(), value))
        })
        .collect()
}

fn optional_string_map(
    item: &Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<Option<HashMap<String, String>>, String> {
    item.get(key)
        .map(|value| string_map(value, label))
        .transpose()
}

pub(crate) fn string_array(value: &Value, label: &str) -> Result<Vec<String>, String> {
    value
        .as_array()
        .ok_or_else(|| format!("{label} must be an array"))?
        .iter()
        .enumerate()
        .map(|(index, value)| string_value(value, &format!("{label}[{index}]")))
        .collect()
}

fn enum_string(value: &Value, label: &str, allowed: &[&str]) -> Result<String, String> {
    let value = string_value(value, label)?;
    if allowed.contains(&value.as_str()) {
        Ok(value)
    } else {
        Err(format!("{label} is invalid"))
    }
}

pub(crate) fn agent_status(value: &Value, label: &str) -> Result<String, String> {
    enum_string(
        value,
        label,
        &["idle", "working", "blocked", "done", "unknown"],
    )
}

fn agent_session(value: &Value, label: &str) -> Result<HerdrAgentSessionInfo, String> {
    let item = object(value, label)?;
    Ok(HerdrAgentSessionInfo {
        source: non_empty_string_value(
            required(item, "source", &format!("{label}.source"))?,
            &format!("{label}.source"),
        )?,
        agent: non_empty_string_value(
            required(item, "agent", &format!("{label}.agent"))?,
            &format!("{label}.agent"),
        )?,
        kind: enum_string(
            required(item, "kind", &format!("{label}.kind"))?,
            &format!("{label}.kind"),
            &["id", "path"],
        )
        .map_err(|_| format!("{label}.kind must be id or path"))?,
        value: string_value(
            required(item, "value", &format!("{label}.value"))?,
            &format!("{label}.value"),
        )?,
    })
}

fn pane_scroll(value: &Value, label: &str) -> Result<HerdrPaneScrollInfo, String> {
    let item = object(value, label)?;
    Ok(HerdrPaneScrollInfo {
        offset_from_bottom: non_negative_number(
            required(
                item,
                "offset_from_bottom",
                &format!("{label}.offset_from_bottom"),
            )?,
            &format!("{label}.offset_from_bottom"),
        )?,
        max_offset_from_bottom: non_negative_number(
            required(
                item,
                "max_offset_from_bottom",
                &format!("{label}.max_offset_from_bottom"),
            )?,
            &format!("{label}.max_offset_from_bottom"),
        )?,
        viewport_rows: non_negative_number(
            required(item, "viewport_rows", &format!("{label}.viewport_rows"))?,
            &format!("{label}.viewport_rows"),
        )?,
    })
}

fn optional_decoded<T>(
    item: &Map<String, Value>,
    key: &str,
    label: &str,
    decode: impl FnOnce(&Value, &str) -> Result<T, String>,
) -> Result<Option<T>, String> {
    item.get(key).map(|value| decode(value, label)).transpose()
}

pub(crate) fn workspace(value: &Value, label: &str) -> Result<HerdrWorkspaceInfo, String> {
    let item = object(value, label)?;
    Ok(HerdrWorkspaceInfo {
        workspace_id: non_empty_string_value(
            required(item, "workspace_id", &format!("{label}.workspace_id"))?,
            &format!("{label}.workspace_id"),
        )?,
        number: non_negative_number(
            required(item, "number", &format!("{label}.number"))?,
            &format!("{label}.number"),
        )?,
        label: required_string(item, "label", &format!("{label}.label"))?,
        focused: bool_value(
            required(item, "focused", &format!("{label}.focused"))?,
            &format!("{label}.focused"),
        )?,
        pane_count: non_negative_number(
            required(item, "pane_count", &format!("{label}.pane_count"))?,
            &format!("{label}.pane_count"),
        )?,
        tab_count: non_negative_number(
            required(item, "tab_count", &format!("{label}.tab_count"))?,
            &format!("{label}.tab_count"),
        )?,
        active_tab_id: required_string(item, "active_tab_id", &format!("{label}.active_tab_id"))?,
        agent_status: agent_status(
            required(item, "agent_status", &format!("{label}.agent_status"))?,
            &format!("{label}.agent_status"),
        )?,
        tokens: optional_string_map(item, "tokens", &format!("{label}.tokens"))?,
        worktree: optional_decoded(
            item,
            "worktree",
            &format!("{label}.worktree"),
            workspace_worktree,
        )?,
    })
}

fn workspace_worktree(value: &Value, label: &str) -> Result<HerdrWorkspaceWorktreeInfo, String> {
    let item = object(value, label)?;
    Ok(HerdrWorkspaceWorktreeInfo {
        repo_key: non_empty_string_value(
            required(item, "repo_key", &format!("{label}.repo_key"))?,
            &format!("{label}.repo_key"),
        )?,
        repo_name: non_empty_string_value(
            required(item, "repo_name", &format!("{label}.repo_name"))?,
            &format!("{label}.repo_name"),
        )?,
        repo_root: non_empty_string_value(
            required(item, "repo_root", &format!("{label}.repo_root"))?,
            &format!("{label}.repo_root"),
        )?,
        checkout_path: non_empty_string_value(
            required(item, "checkout_path", &format!("{label}.checkout_path"))?,
            &format!("{label}.checkout_path"),
        )?,
        is_linked_worktree: bool_value(
            required(
                item,
                "is_linked_worktree",
                &format!("{label}.is_linked_worktree"),
            )?,
            &format!("{label}.is_linked_worktree"),
        )?,
    })
}

pub(crate) fn worktree(value: &Value, label: &str) -> Result<HerdrWorktreeInfo, String> {
    let item = object(value, label)?;
    Ok(HerdrWorktreeInfo {
        branch: optional_string(item, "branch", &format!("{label}.branch"))?,
        is_bare: bool_value(
            required(item, "is_bare", &format!("{label}.is_bare"))?,
            &format!("{label}.is_bare"),
        )?,
        is_detached: bool_value(
            required(item, "is_detached", &format!("{label}.is_detached"))?,
            &format!("{label}.is_detached"),
        )?,
        is_linked_worktree: bool_value(
            required(
                item,
                "is_linked_worktree",
                &format!("{label}.is_linked_worktree"),
            )?,
            &format!("{label}.is_linked_worktree"),
        )?,
        is_prunable: bool_value(
            required(item, "is_prunable", &format!("{label}.is_prunable"))?,
            &format!("{label}.is_prunable"),
        )?,
        label: required_string(item, "label", &format!("{label}.label"))?,
        open_workspace_id: optional_string(
            item,
            "open_workspace_id",
            &format!("{label}.open_workspace_id"),
        )?,
        path: non_empty_string_value(
            required(item, "path", &format!("{label}.path"))?,
            &format!("{label}.path"),
        )?,
    })
}

pub(crate) fn tab(value: &Value, label: &str) -> Result<HerdrTabInfo, String> {
    let item = object(value, label)?;
    Ok(HerdrTabInfo {
        tab_id: non_empty_string_value(
            required(item, "tab_id", &format!("{label}.tab_id"))?,
            &format!("{label}.tab_id"),
        )?,
        workspace_id: non_empty_string_value(
            required(item, "workspace_id", &format!("{label}.workspace_id"))?,
            &format!("{label}.workspace_id"),
        )?,
        number: non_negative_number(
            required(item, "number", &format!("{label}.number"))?,
            &format!("{label}.number"),
        )?,
        label: required_string(item, "label", &format!("{label}.label"))?,
        focused: bool_value(
            required(item, "focused", &format!("{label}.focused"))?,
            &format!("{label}.focused"),
        )?,
        pane_count: non_negative_number(
            required(item, "pane_count", &format!("{label}.pane_count"))?,
            &format!("{label}.pane_count"),
        )?,
        agent_status: agent_status(
            required(item, "agent_status", &format!("{label}.agent_status"))?,
            &format!("{label}.agent_status"),
        )?,
    })
}

pub(crate) fn pane(value: &Value, label: &str) -> Result<HerdrPaneInfo, String> {
    let item = object(value, label)?;
    Ok(HerdrPaneInfo {
        pane_id: non_empty_string_value(
            required(item, "pane_id", &format!("{label}.pane_id"))?,
            &format!("{label}.pane_id"),
        )?,
        terminal_id: non_empty_string_value(
            required(item, "terminal_id", &format!("{label}.terminal_id"))?,
            &format!("{label}.terminal_id"),
        )?,
        workspace_id: non_empty_string_value(
            required(item, "workspace_id", &format!("{label}.workspace_id"))?,
            &format!("{label}.workspace_id"),
        )?,
        tab_id: non_empty_string_value(
            required(item, "tab_id", &format!("{label}.tab_id"))?,
            &format!("{label}.tab_id"),
        )?,
        focused: bool_value(
            required(item, "focused", &format!("{label}.focused"))?,
            &format!("{label}.focused"),
        )?,
        cwd: optional_string(item, "cwd", &format!("{label}.cwd"))?,
        foreground_cwd: optional_string(
            item,
            "foreground_cwd",
            &format!("{label}.foreground_cwd"),
        )?,
        label: optional_string(item, "label", &format!("{label}.label"))?,
        agent: optional_string(item, "agent", &format!("{label}.agent"))?,
        title: optional_string(item, "title", &format!("{label}.title"))?,
        terminal_title: optional_string(
            item,
            "terminal_title",
            &format!("{label}.terminal_title"),
        )?,
        terminal_title_stripped: optional_string(
            item,
            "terminal_title_stripped",
            &format!("{label}.terminal_title_stripped"),
        )?,
        display_agent: optional_string(item, "display_agent", &format!("{label}.display_agent"))?,
        agent_status: agent_status(
            required(item, "agent_status", &format!("{label}.agent_status"))?,
            &format!("{label}.agent_status"),
        )?,
        state_labels: optional_string_map(item, "state_labels", &format!("{label}.state_labels"))?,
        tokens: optional_string_map(item, "tokens", &format!("{label}.tokens"))?,
        agent_session: optional_decoded(
            item,
            "agent_session",
            &format!("{label}.agent_session"),
            agent_session,
        )?,
        scroll: optional_decoded(item, "scroll", &format!("{label}.scroll"), pane_scroll)?,
        revision: non_negative_number(
            required(item, "revision", &format!("{label}.revision"))?,
            &format!("{label}.revision"),
        )?,
    })
}

fn agent(value: &Value, label: &str) -> Result<HerdrAgentInfo, String> {
    let item = object(value, label)?;
    Ok(HerdrAgentInfo {
        pane_id: non_empty_string_value(
            required(item, "pane_id", &format!("{label}.pane_id"))?,
            &format!("{label}.pane_id"),
        )?,
        terminal_id: non_empty_string_value(
            required(item, "terminal_id", &format!("{label}.terminal_id"))?,
            &format!("{label}.terminal_id"),
        )?,
        workspace_id: non_empty_string_value(
            required(item, "workspace_id", &format!("{label}.workspace_id"))?,
            &format!("{label}.workspace_id"),
        )?,
        tab_id: non_empty_string_value(
            required(item, "tab_id", &format!("{label}.tab_id"))?,
            &format!("{label}.tab_id"),
        )?,
        focused: bool_value(
            required(item, "focused", &format!("{label}.focused"))?,
            &format!("{label}.focused"),
        )?,
        agent_status: agent_status(
            required(item, "agent_status", &format!("{label}.agent_status"))?,
            &format!("{label}.agent_status"),
        )?,
        revision: non_negative_number(
            required(item, "revision", &format!("{label}.revision"))?,
            &format!("{label}.revision"),
        )?,
        cwd: optional_string(item, "cwd", &format!("{label}.cwd"))?,
        foreground_cwd: optional_string(
            item,
            "foreground_cwd",
            &format!("{label}.foreground_cwd"),
        )?,
        agent: optional_string(item, "agent", &format!("{label}.agent"))?,
        name: optional_string(item, "name", &format!("{label}.name"))?,
        title: optional_string(item, "title", &format!("{label}.title"))?,
        terminal_title: optional_string(
            item,
            "terminal_title",
            &format!("{label}.terminal_title"),
        )?,
        terminal_title_stripped: optional_string(
            item,
            "terminal_title_stripped",
            &format!("{label}.terminal_title_stripped"),
        )?,
        display_agent: optional_string(item, "display_agent", &format!("{label}.display_agent"))?,
        interactive_ready: optional_bool(
            item,
            "interactive_ready",
            &format!("{label}.interactive_ready"),
        )?,
        launch_pending: optional_bool(item, "launch_pending", &format!("{label}.launch_pending"))?,
        screen_detection_skipped: optional_bool(
            item,
            "screen_detection_skipped",
            &format!("{label}.screen_detection_skipped"),
        )?,
        state_change_seq: optional_number(
            item,
            "state_change_seq",
            &format!("{label}.state_change_seq"),
        )?,
        state_labels: optional_string_map(item, "state_labels", &format!("{label}.state_labels"))?,
        tokens: optional_string_map(item, "tokens", &format!("{label}.tokens"))?,
        agent_session: optional_decoded(
            item,
            "agent_session",
            &format!("{label}.agent_session"),
            agent_session,
        )?,
    })
}

fn pane_rect(value: &Value, label: &str) -> Result<HerdrPaneLayoutRect, String> {
    let item = object(value, label)?;
    Ok(HerdrPaneLayoutRect {
        x: finite_number(
            required(item, "x", &format!("{label}.x"))?,
            &format!("{label}.x"),
        )?,
        y: finite_number(
            required(item, "y", &format!("{label}.y"))?,
            &format!("{label}.y"),
        )?,
        width: non_negative_number(
            required(item, "width", &format!("{label}.width"))?,
            &format!("{label}.width"),
        )?,
        height: non_negative_number(
            required(item, "height", &format!("{label}.height"))?,
            &format!("{label}.height"),
        )?,
    })
}

pub(crate) fn pane_layout(value: &Value, label: &str) -> Result<HerdrPaneLayoutSnapshot, String> {
    let item = object(value, label)?;
    let panes = required(item, "panes", &format!("{label}.panes"))?
        .as_array()
        .ok_or_else(|| format!("{label}.panes must be an array"))?
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let pane_label = format!("{label}.panes[{index}]");
            let pane = object(value, &pane_label)?;
            Ok(HerdrPaneLayoutPane {
                pane_id: non_empty_string_value(
                    required(pane, "pane_id", &format!("{pane_label}.pane_id"))?,
                    &format!("{pane_label}.pane_id"),
                )?,
                focused: bool_value(
                    required(pane, "focused", &format!("{pane_label}.focused"))?,
                    &format!("{pane_label}.focused"),
                )?,
                rect: pane_rect(
                    required(pane, "rect", &format!("{pane_label}.rect"))?,
                    &format!("{pane_label}.rect"),
                )?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let splits = required(item, "splits", &format!("{label}.splits"))?
        .as_array()
        .ok_or_else(|| format!("{label}.splits must be an array"))?
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let split_label = format!("{label}.splits[{index}]");
            let split = object(value, &split_label)?;
            let direction = enum_string(
                required(split, "direction", &format!("{split_label}.direction"))?,
                &format!("{split_label}.direction"),
                &["right", "down"],
            )
            .map_err(|_| format!("{split_label}.direction must be right or down"))?;
            Ok(HerdrPaneLayoutSplit {
                id: non_empty_string_value(
                    required(split, "id", &format!("{split_label}.id"))?,
                    &format!("{split_label}.id"),
                )?,
                direction,
                ratio: finite_number(
                    required(split, "ratio", &format!("{split_label}.ratio"))?,
                    &format!("{split_label}.ratio"),
                )?,
                rect: pane_rect(
                    required(split, "rect", &format!("{split_label}.rect"))?,
                    &format!("{split_label}.rect"),
                )?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(HerdrPaneLayoutSnapshot {
        workspace_id: non_empty_string_value(
            required(item, "workspace_id", &format!("{label}.workspace_id"))?,
            &format!("{label}.workspace_id"),
        )?,
        tab_id: non_empty_string_value(
            required(item, "tab_id", &format!("{label}.tab_id"))?,
            &format!("{label}.tab_id"),
        )?,
        zoomed: bool_value(
            required(item, "zoomed", &format!("{label}.zoomed"))?,
            &format!("{label}.zoomed"),
        )?,
        area: pane_rect(
            required(item, "area", &format!("{label}.area"))?,
            &format!("{label}.area"),
        )?,
        focused_pane_id: non_empty_string_value(
            required(item, "focused_pane_id", &format!("{label}.focused_pane_id"))?,
            &format!("{label}.focused_pane_id"),
        )?,
        panes,
        splits,
    })
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

fn session_snapshot(value: &Value) -> Result<HerdrSessionSnapshot, String> {
    let item = object(value, "snapshot")?;
    Ok(HerdrSessionSnapshot {
        version: required_string(item, "version", "snapshot.version")?,
        protocol: required_u32(item, "protocol", "snapshot.protocol")?,
        focused_workspace_id: optional_nullable_string(
            item,
            "focused_workspace_id",
            "snapshot.focused_workspace_id",
        )?,
        focused_tab_id: optional_nullable_string(
            item,
            "focused_tab_id",
            "snapshot.focused_tab_id",
        )?,
        focused_pane_id: optional_nullable_string(
            item,
            "focused_pane_id",
            "snapshot.focused_pane_id",
        )?,
        agents: decoded_array(
            required(item, "agents", "snapshot.agents")?,
            "snapshot.agents",
            agent,
        )?,
        workspaces: decoded_array(
            required(item, "workspaces", "snapshot.workspaces")?,
            "snapshot.workspaces",
            workspace,
        )?,
        tabs: decoded_array(
            required(item, "tabs", "snapshot.tabs")?,
            "snapshot.tabs",
            tab,
        )?,
        panes: decoded_array(
            required(item, "panes", "snapshot.panes")?,
            "snapshot.panes",
            pane,
        )?,
        layouts: decoded_array(
            required(item, "layouts", "snapshot.layouts")?,
            "snapshot.layouts",
            pane_layout,
        )?,
    })
}

fn optional_nullable_string(
    item: &Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<Option<String>, String> {
    match item.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => string_value(value, label).map(Some),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn representative_requests_match_typescript_fixtures() {
        assert_eq!(
            String::from_utf8(HerdrControlRequest::Ping.encode("android_1").unwrap()).unwrap(),
            "{\"id\":\"android_1\",\"method\":\"ping\",\"params\":{}}\n"
        );
        assert_eq!(
            String::from_utf8(
                HerdrControlRequest::WorkspaceCreate {
                    label: None,
                    cwd: Some("/tmp".into())
                }
                .encode("android_2")
                .unwrap()
            )
            .unwrap(),
            "{\"id\":\"android_2\",\"method\":\"workspace.create\",\"params\":{\"label\":null,\"cwd\":\"/tmp\",\"focus\":true}}\n"
        );
        assert_eq!(
            String::from_utf8(
                HerdrControlRequest::PaneSendInput {
                    pane_id: "w1:p1".into(),
                    text: "hello".into(),
                    keys: vec!["enter".into()]
                }
                .encode("android_3")
                .unwrap()
            )
            .unwrap(),
            "{\"id\":\"android_3\",\"method\":\"pane.send_input\",\"params\":{\"pane_id\":\"w1:p1\",\"text\":\"hello\",\"keys\":[\"enter\"]}}\n"
        );
    }

    #[test]
    fn optional_agent_args_are_omitted_when_empty() {
        let request = HerdrControlRequest::AgentStart {
            name: "codex-1".into(),
            kind: "codex".into(),
            pane_id: "p1".into(),
            args: vec![],
        };
        let encoded = String::from_utf8(request.encode("android_4").unwrap()).unwrap();
        assert_eq!(
            encoded,
            "{\"id\":\"android_4\",\"method\":\"agent.start\",\"params\":{\"name\":\"codex-1\",\"kind\":\"codex\",\"pane_id\":\"p1\"}}\n"
        );
        assert_eq!(
            String::from_utf8(
                HerdrControlRequest::AgentFocus {
                    target: "codex-1".into()
                }
                .encode("android_5")
                .unwrap()
            )
            .unwrap(),
            "{\"id\":\"android_5\",\"method\":\"agent.focus\",\"params\":{\"target\":\"codex-1\"}}\n"
        );
    }

    #[test]
    fn successful_and_error_responses_are_typed() {
        let pong = parse_response(
            &HerdrControlRequest::Ping,
            br#"{"id":"android_1","result":{"type":"pong","version":"1.2.3","protocol":20}}"#,
        )
        .unwrap();
        assert_eq!(pong.kind, "pong");
        assert_eq!(pong.version.as_deref(), Some("1.2.3"));
        assert_eq!(pong.protocol, Some(20));
        assert_eq!(
            parse_response(
                &HerdrControlRequest::Ping,
                br#"{"id":"android_1","error":{"code":"bad_request","message":"No session"}}"#
            ),
            Err(HerdrControlError::ProtocolError(
                "bad_request".into(),
                "No session".into()
            ))
        );
    }

    #[test]
    fn malformed_missing_and_unexpected_responses_are_rejected() {
        assert!(matches!(
            parse_response(&HerdrControlRequest::Ping, b"{"),
            Err(HerdrControlError::MalformedResponse(_))
        ));
        assert!(matches!(
            parse_response(&HerdrControlRequest::Ping, br#"{"id":"android_1"}"#),
            Err(HerdrControlError::MalformedResponse(_))
        ));
        assert!(matches!(
            parse_response(
                &HerdrControlRequest::Ping,
                br#"{"result":{"type":"pong","version":"x"}}"#
            ),
            Err(HerdrControlError::InvalidField(_))
        ));
        assert!(matches!(
            parse_response(&HerdrControlRequest::Ping, br#"{"result":{"type":"ok"}}"#),
            Err(HerdrControlError::UnsupportedResponse(_))
        ));
    }
}
