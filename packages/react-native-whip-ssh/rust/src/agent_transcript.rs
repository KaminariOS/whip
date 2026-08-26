//! Agent-independent transcript domain model and Codex JSONL adapter.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const MAX_TRANSCRIPT_LINE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
pub enum AgentTranscriptKind {
    Codex,
    OpenCode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
pub enum AgentTranscriptStatus {
    Loading,
    Live,
    Stale,
    Unavailable,
    Error,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
pub enum AgentMessageRole {
    User,
    Assistant,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
pub enum AgentToolStatus {
    Pending,
    Running,
    Completed,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
pub enum AgentNoticeLevel {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
pub enum AgentTurnStatus {
    Idle,
    Working,
    Interrupted,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Enum)]
pub enum AgentScalarValue {
    String { value: String },
    Number { value: f64 },
    Boolean { value: bool },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct AgentField {
    pub key: String,
    pub value: AgentScalarValue,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct AgentFileDiff {
    pub file: String,
    pub patch: Option<String>,
    pub before: Option<String>,
    pub after: Option<String>,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct AgentToolState {
    pub status: AgentToolStatus,
    pub input: Vec<AgentField>,
    pub output: Option<String>,
    pub error: Option<String>,
    pub title: Option<String>,
    pub started_at_ms: Option<u64>,
    pub completed_at_ms: Option<u64>,
    pub exit_code: Option<i64>,
    pub files: Vec<AgentFileDiff>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Enum)]
#[allow(clippy::large_enum_variant)]
pub enum AgentTranscriptPart {
    Text {
        id: String,
        text: String,
        timestamp_ms: Option<u64>,
    },
    Reasoning {
        id: String,
        text: String,
        timestamp_ms: Option<u64>,
    },
    Tool {
        id: String,
        call_id: String,
        tool: String,
        timestamp_ms: Option<u64>,
        state: AgentToolState,
    },
    Plan {
        id: String,
        text: String,
        timestamp_ms: Option<u64>,
    },
    Notice {
        id: String,
        level: AgentNoticeLevel,
        text: String,
        timestamp_ms: Option<u64>,
    },
}

impl AgentTranscriptPart {
    fn id(&self) -> &str {
        match self {
            Self::Text { id, .. }
            | Self::Reasoning { id, .. }
            | Self::Tool { id, .. }
            | Self::Plan { id, .. }
            | Self::Notice { id, .. } => id,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct AgentTranscriptMessage {
    pub id: String,
    pub role: AgentMessageRole,
    pub parent_id: Option<String>,
    pub created_at_ms: Option<u64>,
    pub completed_at_ms: Option<u64>,
    pub error: Option<String>,
    pub parts: Vec<AgentTranscriptPart>,
    pub diffs: Vec<AgentFileDiff>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct AgentTranscriptTurn {
    pub id: String,
    pub user_message_id: Option<String>,
    pub assistant_message_ids: Vec<String>,
    pub status: AgentTurnStatus,
    pub started_at_ms: Option<u64>,
    pub completed_at_ms: Option<u64>,
    pub diffs: Vec<AgentFileDiff>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct AgentTranscriptInfo {
    pub id: String,
    pub title: Option<String>,
    pub directory: Option<String>,
    pub created_at_ms: Option<u64>,
    pub updated_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct AgentTranscriptState {
    pub session_id: String,
    pub agent: AgentTranscriptKind,
    pub revision: u64,
    pub status: AgentTranscriptStatus,
    pub info: Option<AgentTranscriptInfo>,
    pub messages: Vec<AgentTranscriptMessage>,
    pub turns: Vec<AgentTranscriptTurn>,
    pub error: Option<String>,
}

impl AgentTranscriptState {
    pub fn empty(session_id: String, agent: AgentTranscriptKind) -> Self {
        Self {
            info: Some(AgentTranscriptInfo {
                id: session_id.clone(),
                title: None,
                directory: None,
                created_at_ms: None,
                updated_at_ms: None,
            }),
            session_id,
            agent,
            revision: 0,
            status: AgentTranscriptStatus::Loading,
            messages: Vec::new(),
            turns: Vec::new(),
            error: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexSourceIdentity {
    pub requested_session_id: String,
    pub rollout_path: String,
    pub file_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FramedLine {
    pub raw_line: String,
    pub end_offset: u64,
    pub parsed: Result<Value, String>,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum TranscriptParseError {
    #[error("transcript record exceeded {MAX_TRANSCRIPT_LINE_BYTES} bytes")]
    LineTooLarge,
    #[error("transcript contained invalid UTF-8")]
    InvalidUtf8,
}

/// Incremental byte-oriented JSONL framer. Its committed cursor never includes
/// an incomplete or malformed physical line.
#[derive(Clone, Debug, Default)]
pub struct TranscriptJsonlFramer {
    buffer: Vec<u8>,
    received_offset: u64,
    committable_offset: u64,
}

impl TranscriptJsonlFramer {
    pub fn with_offset(offset: u64) -> Self {
        Self {
            buffer: Vec::new(),
            received_offset: offset,
            committable_offset: offset,
        }
    }

    pub fn received_offset(&self) -> u64 {
        self.received_offset
    }

    pub fn committable_offset(&self) -> u64 {
        self.committable_offset
    }

    pub fn partial_len(&self) -> usize {
        self.buffer.len()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<FramedLine>, TranscriptParseError> {
        self.received_offset = self
            .received_offset
            .saturating_add(u64::try_from(chunk.len()).unwrap_or(u64::MAX));
        self.buffer.extend_from_slice(chunk);
        if self.buffer.len() > MAX_TRANSCRIPT_LINE_BYTES && !self.buffer.contains(&b'\n') {
            return Err(TranscriptParseError::LineTooLarge);
        }
        let mut lines = Vec::new();
        let mut consumed = 0usize;
        while let Some(relative) = self.buffer[consumed..]
            .iter()
            .position(|byte| *byte == b'\n')
        {
            let end = consumed + relative + 1;
            if end - consumed > MAX_TRANSCRIPT_LINE_BYTES {
                return Err(TranscriptParseError::LineTooLarge);
            }
            let physical = &self.buffer[consumed..end];
            let mut content = &physical[..physical.len() - 1];
            if content.last() == Some(&b'\r') {
                content = &content[..content.len() - 1];
            }
            let raw_line = std::str::from_utf8(content)
                .map_err(|_| TranscriptParseError::InvalidUtf8)?
                .to_owned();
            let end_offset = self
                .received_offset
                .saturating_sub(u64::try_from(self.buffer.len() - end).unwrap_or(0));
            let parsed = if content.is_empty() {
                Ok(Value::Null)
            } else {
                serde_json::from_slice(content).map_err(|error| error.to_string())
            };
            if parsed.is_ok() {
                self.committable_offset = end_offset;
            }
            lines.push(FramedLine {
                raw_line,
                end_offset,
                parsed,
            });
            consumed = end;
        }
        if consumed > 0 {
            self.buffer.drain(..consumed);
        }
        if self.buffer.len() > MAX_TRANSCRIPT_LINE_BYTES {
            return Err(TranscriptParseError::LineTooLarge);
        }
        Ok(lines)
    }

    pub fn reset(&mut self, offset: u64) {
        *self = Self::with_offset(offset);
    }
}

#[derive(Clone, Debug)]
struct ToolLocation {
    message_id: String,
}

#[derive(Clone, Debug)]
struct PendingTool {
    target_id: String,
    tool: String,
    input: Vec<AgentField>,
    continuation: bool,
    files: Vec<AgentFileDiff>,
}

#[derive(Clone, Debug)]
pub struct CodexTranscriptAdapter {
    session_id: String,
    directory: Option<String>,
    messages: Vec<AgentTranscriptMessage>,
    message_indexes: HashMap<String, usize>,
    tools: HashMap<String, ToolLocation>,
    pending_tools: HashMap<String, PendingTool>,
    process_tools: HashMap<i64, String>,
    recent_messages: HashMap<String, (String, u64)>,
    sequence: u64,
    active_user_message_id: Option<String>,
    active_assistant_message_id: Option<String>,
}

impl CodexTranscriptAdapter {
    pub fn new(session_id: impl Into<String>) -> Self {
        let session_id = session_id.into();
        Self {
            session_id,
            directory: None,
            messages: Vec::new(),
            message_indexes: HashMap::new(),
            tools: HashMap::new(),
            pending_tools: HashMap::new(),
            process_tools: HashMap::new(),
            recent_messages: HashMap::new(),
            sequence: 0,
            active_user_message_id: None,
            active_assistant_message_id: None,
        }
    }

    pub fn accept(&mut self, value: &Value) -> bool {
        let Some(record) = value.as_object() else {
            return false;
        };
        let Some(record_type) = nonempty(record.get("type")) else {
            return false;
        };
        self.sequence = self.sequence.saturating_add(1);
        let at = timestamp_ms(record.get("timestamp"));
        match record_type {
            "session_meta" => {
                if let Some(payload) = object(record.get("payload")) {
                    if let Some(id) = nonempty(payload.get("id")) {
                        self.session_id = id.to_owned();
                    }
                    if let Some(cwd) = nonempty(payload.get("cwd")) {
                        self.directory = Some(cwd.to_owned());
                    }
                }
            }
            "thread.started" => {
                if let Some(id) = nonempty(record.get("thread_id")).or_else(|| {
                    object(record.get("thread")).and_then(|thread| nonempty(thread.get("id")))
                }) {
                    self.session_id = id.to_owned();
                }
            }
            "item.completed" => {
                if let Some(item) = object(record.get("item")) {
                    self.accept_completed_item(item, at);
                }
            }
            "response_item" => {
                if let Some(payload) = object(record.get("payload")) {
                    self.accept_response(payload, at);
                }
            }
            "event_msg" => {
                if let Some(payload) = object(record.get("payload")) {
                    self.accept_event(payload, at);
                }
            }
            _ => return false,
        }
        true
    }

    pub fn snapshot(
        &self,
        revision: u64,
        status: AgentTranscriptStatus,
        error: Option<String>,
    ) -> AgentTranscriptState {
        let messages = self.messages.clone();
        let turns = project_turns(&messages);
        AgentTranscriptState {
            session_id: self.session_id.clone(),
            agent: AgentTranscriptKind::Codex,
            revision,
            status,
            info: Some(AgentTranscriptInfo {
                id: self.session_id.clone(),
                title: None,
                directory: self.directory.clone(),
                created_at_ms: None,
                updated_at_ms: None,
            }),
            messages,
            turns,
            error,
        }
    }

    fn put_message(&mut self, message: AgentTranscriptMessage) {
        if let Some(index) = self.message_indexes.get(&message.id).copied() {
            self.messages[index] = message;
        } else {
            self.message_indexes
                .insert(message.id.clone(), self.messages.len());
            self.messages.push(message);
        }
    }

    fn message(&self, id: &str) -> Option<&AgentTranscriptMessage> {
        self.message_indexes
            .get(id)
            .and_then(|index| self.messages.get(*index))
    }

    fn message_mut(&mut self, id: &str) -> Option<&mut AgentTranscriptMessage> {
        let index = *self.message_indexes.get(id)?;
        self.messages.get_mut(index)
    }

    fn begin_turn(&mut self) {
        self.active_user_message_id = None;
        self.active_assistant_message_id = None;
    }

    fn user_message(&mut self, text: String, id: String, at: Option<u64>) {
        let text = text.trim().to_owned();
        if text.is_empty() || injected_user_context(&text) {
            return;
        }
        let signature = format!("user\n{text}");
        if let Some((existing, sequence)) = self.recent_messages.get_mut(&signature)
            && self.sequence.saturating_sub(*sequence) <= 4
        {
            *sequence = self.sequence;
            self.active_user_message_id = Some(existing.clone());
            return;
        }
        let message_id = format!("user:{id}");
        self.recent_messages
            .insert(signature, (message_id.clone(), self.sequence));
        self.put_message(AgentTranscriptMessage {
            id: message_id.clone(),
            role: AgentMessageRole::User,
            parent_id: None,
            created_at_ms: at,
            completed_at_ms: None,
            error: None,
            parts: vec![AgentTranscriptPart::Text {
                id: format!("{message_id}:text"),
                text,
                timestamp_ms: at,
            }],
            diffs: Vec::new(),
        });
        self.active_user_message_id = Some(message_id);
        self.active_assistant_message_id = None;
    }

    fn assistant_message_id(&mut self, at: Option<u64>) -> String {
        if let Some(id) = self.active_assistant_message_id.clone()
            && self.message(&id).is_some()
        {
            return id;
        }
        let id = format!(
            "assistant:{}",
            self.active_user_message_id
                .clone()
                .unwrap_or_else(|| self.sequence.to_string())
        );
        if self.message(&id).is_none() {
            self.put_message(AgentTranscriptMessage {
                id: id.clone(),
                role: AgentMessageRole::Assistant,
                parent_id: self.active_user_message_id.clone(),
                created_at_ms: at,
                completed_at_ms: None,
                error: None,
                parts: Vec::new(),
                diffs: Vec::new(),
            });
        }
        self.active_assistant_message_id = Some(id.clone());
        id
    }

    fn assistant_text(&mut self, text: String, id: String, at: Option<u64>, reasoning: bool) {
        let text = text.trim().to_owned();
        if text.is_empty() {
            return;
        }
        let signature = format!(
            "{}\n{text}",
            if reasoning { "reasoning" } else { "assistant" }
        );
        if let Some((_, sequence)) = self.recent_messages.get_mut(&signature)
            && self.sequence.saturating_sub(*sequence) <= 4
        {
            *sequence = self.sequence;
            return;
        }
        let message_id = self.assistant_message_id(at);
        let part_id = format!("{}:{id}", if reasoning { "reasoning" } else { "text" });
        self.recent_messages
            .insert(signature, (part_id.clone(), self.sequence));
        let part = if reasoning {
            AgentTranscriptPart::Reasoning {
                id: part_id,
                text,
                timestamp_ms: at,
            }
        } else {
            AgentTranscriptPart::Text {
                id: part_id,
                text,
                timestamp_ms: at,
            }
        };
        if let Some(message) = self.message_mut(&message_id) {
            message.parts.push(part);
        }
    }

    fn put_part(&mut self, part: AgentTranscriptPart, at: Option<u64>) {
        let message_id = self.assistant_message_id(at);
        let id = part.id().to_owned();
        if let Some(message) = self.message_mut(&message_id) {
            if let Some(index) = message.parts.iter().position(|current| current.id() == id) {
                message.parts[index] = part;
            } else {
                message.parts.push(part);
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn tool(
        &mut self,
        id: String,
        name: String,
        status: AgentToolStatus,
        input: Option<Vec<AgentField>>,
        output: Option<String>,
        error: Option<String>,
        exit_code: Option<i64>,
        files: Vec<AgentFileDiff>,
        at: Option<u64>,
    ) {
        let key = format!("tool:{id}");
        let message_id = self
            .tools
            .get(&key)
            .map(|location| location.message_id.clone())
            .unwrap_or_else(|| self.assistant_message_id(at));
        let existing = self.message(&message_id).and_then(|message| {
            message.parts.iter().find_map(|part| {
                if let AgentTranscriptPart::Tool {
                    id,
                    state,
                    tool,
                    timestamp_ms,
                    ..
                } = part
                    && id == &key
                {
                    Some((state.clone(), tool.clone(), *timestamp_ms))
                } else {
                    None
                }
            })
        });
        let (old_state, old_name, old_at) = existing.unwrap_or((
            AgentToolState {
                status: AgentToolStatus::Pending,
                input: Vec::new(),
                output: None,
                error: None,
                title: None,
                started_at_ms: at,
                completed_at_ms: None,
                exit_code: None,
                files: Vec::new(),
            },
            String::new(),
            at,
        ));
        let terminal = matches!(status, AgentToolStatus::Completed | AgentToolStatus::Error);
        let part = AgentTranscriptPart::Tool {
            id: key.clone(),
            call_id: id,
            tool: if name.is_empty() {
                if old_name.is_empty() {
                    "tool".to_owned()
                } else {
                    old_name
                }
            } else {
                name
            },
            timestamp_ms: old_at,
            state: AgentToolState {
                status,
                input: input.unwrap_or(old_state.input),
                output: output.or(old_state.output),
                error: error.or(old_state.error),
                title: old_state.title,
                started_at_ms: old_state.started_at_ms.or(at),
                completed_at_ms: if terminal {
                    at
                } else {
                    old_state.completed_at_ms
                },
                exit_code: exit_code.or(old_state.exit_code),
                files: if files.is_empty() {
                    old_state.files
                } else {
                    files
                },
            },
        };
        if let Some(message) = self.message_mut(&message_id) {
            if let Some(index) = message.parts.iter().position(|current| current.id() == key) {
                message.parts[index] = part;
            } else {
                message.parts.push(part);
            }
        }
        self.tools.insert(key, ToolLocation { message_id });
    }

    fn accept_completed_item(&mut self, item: &Map<String, Value>, at: Option<u64>) {
        let kind = nonempty(item.get("type")).unwrap_or_default();
        let id = nonempty(item.get("id"))
            .map(str::to_owned)
            .unwrap_or_else(|| self.sequence.to_string());
        match kind {
            "message" if item.get("role").and_then(Value::as_str) == Some("user") => {
                self.user_message(text_content(item.get("content")), id, at);
            }
            "agent_message" => self.assistant_text(
                nonempty(item.get("text")).unwrap_or_default().to_owned(),
                id,
                at,
                false,
            ),
            "reasoning" => self.assistant_text(
                nonempty(item.get("text"))
                    .map(str::to_owned)
                    .unwrap_or_else(|| text_content(item.get("summary"))),
                id,
                at,
                true,
            ),
            "command_execution" => {
                let exit = item.get("exit_code").and_then(Value::as_i64);
                self.tool(
                    id,
                    "shell".to_owned(),
                    if exit.is_some_and(|code| code != 0) {
                        AgentToolStatus::Error
                    } else {
                        AgentToolStatus::Completed
                    },
                    fields([("command", command_title(item.get("command")))]),
                    nonempty(item.get("aggregated_output")).map(str::to_owned),
                    exit.filter(|code| *code != 0)
                        .map(|code| format!("Exited with code {code}")),
                    exit,
                    Vec::new(),
                    at,
                );
            }
            "function_call" => {
                let name = nonempty(item.get("name")).unwrap_or("tool");
                let (tool, input, _, _, files) = translate_tool(name, item.get("arguments"));
                self.tool(
                    id,
                    tool,
                    parse_tool_status(item.get("status"), AgentToolStatus::Completed),
                    Some(input),
                    nonempty(item.get("output")).map(str::to_owned),
                    None,
                    None,
                    files,
                    at,
                );
            }
            _ => {}
        }
    }

    fn accept_response(&mut self, payload: &Map<String, Value>, at: Option<u64>) {
        let kind = nonempty(payload.get("type")).unwrap_or_default();
        let item_id = nonempty(payload.get("id"))
            .map(str::to_owned)
            .unwrap_or_else(|| self.sequence.to_string());
        let call_id = nonempty(payload.get("call_id"))
            .map(str::to_owned)
            .unwrap_or_else(|| item_id.clone());
        match kind {
            "message" => {
                let content = text_content(payload.get("content"));
                match payload.get("role").and_then(Value::as_str) {
                    Some("assistant") => self.assistant_text(
                        content,
                        item_id,
                        at,
                        payload.get("phase").and_then(Value::as_str) == Some("commentary"),
                    ),
                    Some("user") => self.user_message(content, item_id, at),
                    _ => {}
                }
            }
            "reasoning" => {
                self.assistant_text(text_content(payload.get("summary")), item_id, at, true)
            }
            "local_shell_call" => {
                let (tool, input, _, _, files) = translate_tool("shell", payload.get("action"));
                self.tool(
                    call_id,
                    tool,
                    parse_tool_status(payload.get("status"), AgentToolStatus::Running),
                    Some(input),
                    None,
                    None,
                    None,
                    files,
                    at,
                );
            }
            "function_call" | "custom_tool_call" | "tool_search_call" => {
                let name = nonempty(payload.get("name"))
                    .or_else(|| nonempty(payload.get("execution")))
                    .unwrap_or("tool");
                let raw = payload.get("arguments").or_else(|| payload.get("input"));
                let (tool, input, process_id, continuation, files) = translate_tool(name, raw);
                let target_id = if continuation {
                    process_id.and_then(|id| self.process_tools.get(&id).cloned())
                } else {
                    None
                }
                .unwrap_or_else(|| call_id.clone());
                let current = self.tool_state(&target_id);
                self.pending_tools.insert(
                    call_id,
                    PendingTool {
                        target_id: target_id.clone(),
                        tool: tool.clone(),
                        input: input.clone(),
                        continuation,
                        files: files.clone(),
                    },
                );
                self.tool(
                    target_id,
                    tool,
                    AgentToolStatus::Running,
                    Some(
                        current
                            .as_ref()
                            .map(|state| state.input.clone())
                            .unwrap_or(input),
                    ),
                    current.and_then(|state| state.output),
                    None,
                    None,
                    files,
                    at,
                );
            }
            "function_call_output" | "custom_tool_call_output" => {
                if let Some(pending) = self.pending_tools.remove(&call_id) {
                    let result = tool_result(payload.get("output"));
                    if let Some(process) = result.process_id {
                        self.process_tools
                            .insert(process, pending.target_id.clone());
                    }
                    let current = self.tool_state(&pending.target_id);
                    let output = if pending.continuation {
                        [
                            current.as_ref().and_then(|state| state.output.clone()),
                            result.output.clone(),
                        ]
                        .into_iter()
                        .flatten()
                        .collect::<String>()
                        .into()
                    } else {
                        result.output.clone()
                    };
                    self.tool(
                        pending.target_id,
                        pending.tool,
                        if result.error.is_some() {
                            AgentToolStatus::Error
                        } else if result.running {
                            AgentToolStatus::Running
                        } else {
                            AgentToolStatus::Completed
                        },
                        Some(
                            current
                                .as_ref()
                                .map(|state| state.input.clone())
                                .unwrap_or(pending.input),
                        ),
                        output,
                        result.error,
                        result.exit_code,
                        pending.files,
                        at,
                    );
                } else {
                    let current = self.tool_state(&call_id);
                    self.tool(
                        call_id,
                        "tool".to_owned(),
                        AgentToolStatus::Completed,
                        current.as_ref().map(|state| state.input.clone()),
                        Some(text_content(payload.get("output"))),
                        None,
                        None,
                        Vec::new(),
                        at,
                    );
                }
            }
            "web_search_call" => self.tool(
                call_id,
                "websearch".to_owned(),
                parse_tool_status(payload.get("status"), AgentToolStatus::Running),
                Some(scalar_fields(payload.get("action"))),
                None,
                None,
                None,
                Vec::new(),
                at,
            ),
            _ => {}
        }
    }

    fn tool_state(&self, id: &str) -> Option<AgentToolState> {
        let key = format!("tool:{id}");
        let location = self.tools.get(&key)?;
        self.message(&location.message_id)?
            .parts
            .iter()
            .find_map(|part| match part {
                AgentTranscriptPart::Tool { id, state, .. } if id == &key => Some(state.clone()),
                _ => None,
            })
    }

    fn accept_event(&mut self, payload: &Map<String, Value>, at: Option<u64>) {
        let kind = nonempty(payload.get("type")).unwrap_or_default();
        let call_id = nonempty(payload.get("call_id"))
            .map(str::to_owned)
            .unwrap_or_else(|| self.sequence.to_string());
        match kind {
            "task_started" => self.begin_turn(),
            "task_complete" => {
                if let Some(id) = self.active_assistant_message_id.clone()
                    && let Some(message) = self.message_mut(&id)
                {
                    message.completed_at_ms = at;
                }
                self.begin_turn();
            }
            "user_message" => self.user_message(
                nonempty(payload.get("message"))
                    .unwrap_or_default()
                    .to_owned(),
                format!("event:{call_id}"),
                at,
            ),
            "agent_message" => self.assistant_text(
                nonempty(payload.get("message"))
                    .unwrap_or_default()
                    .to_owned(),
                format!("event:{call_id}"),
                at,
                false,
            ),
            "agent_reasoning" => self.assistant_text(
                nonempty(payload.get("text")).unwrap_or_default().to_owned(),
                format!("event:{call_id}"),
                at,
                true,
            ),
            "exec_command_begin" => self.tool(
                call_id,
                "shell".to_owned(),
                AgentToolStatus::Running,
                fields_with_cwd(payload),
                None,
                None,
                None,
                Vec::new(),
                at,
            ),
            "exec_command_output_delta" => {}
            "exec_command_end" => {
                let exit = payload.get("exit_code").and_then(Value::as_i64);
                let output = nonempty(payload.get("aggregated_output"))
                    .map(str::to_owned)
                    .or_else(|| {
                        let text = [
                            nonempty(payload.get("stdout")),
                            nonempty(payload.get("stderr")),
                        ]
                        .into_iter()
                        .flatten()
                        .collect::<Vec<_>>()
                        .join("\n");
                        (!text.is_empty()).then_some(text)
                    });
                self.tool(
                    call_id,
                    "shell".to_owned(),
                    parse_tool_status(
                        payload.get("status"),
                        if exit == Some(0) {
                            AgentToolStatus::Completed
                        } else {
                            AgentToolStatus::Error
                        },
                    ),
                    fields_with_cwd(payload),
                    output,
                    exit.filter(|code| *code != 0)
                        .map(|code| format!("Exited with code {code}")),
                    exit,
                    Vec::new(),
                    at,
                );
            }
            "patch_apply_begin" | "patch_apply_updated" => self.tool(
                call_id,
                "patch".to_owned(),
                AgentToolStatus::Running,
                Some(Vec::new()),
                None,
                None,
                None,
                legacy_change_files(payload.get("changes")),
                at,
            ),
            "patch_apply_end" => {
                let output = [
                    nonempty(payload.get("stdout")),
                    nonempty(payload.get("stderr")),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join("\n");
                let failed = payload.get("success").and_then(Value::as_bool) == Some(false);
                self.tool(
                    call_id,
                    "patch".to_owned(),
                    if failed {
                        AgentToolStatus::Error
                    } else {
                        parse_tool_status(payload.get("status"), AgentToolStatus::Completed)
                    },
                    Some(Vec::new()),
                    (!output.is_empty()).then_some(output.clone()),
                    failed.then_some(if output.is_empty() {
                        "Patch failed".to_owned()
                    } else {
                        output
                    }),
                    None,
                    legacy_change_files(payload.get("changes")),
                    at,
                );
            }
            "turn_diff" => {
                let files = unified_diff_files(nonempty(payload.get("unified_diff")));
                if !files.is_empty() {
                    let message_id = self.assistant_message_id(at);
                    if let Some(message) = self.message_mut(&message_id) {
                        message.diffs = files;
                    }
                }
            }
            "mcp_tool_call_begin" | "mcp_tool_call_end" => {
                let invocation = object(payload.get("invocation"));
                let name = invocation
                    .map(|value| {
                        [nonempty(value.get("server")), nonempty(value.get("tool"))]
                            .into_iter()
                            .flatten()
                            .collect::<Vec<_>>()
                            .join(" · ")
                    })
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| "mcp".to_owned());
                let ended = kind.ends_with("_end");
                let failed =
                    object(payload.get("result")).is_some_and(|result| result.contains_key("Err"));
                self.tool(
                    call_id,
                    name,
                    if !ended {
                        AgentToolStatus::Running
                    } else if failed {
                        AgentToolStatus::Error
                    } else {
                        AgentToolStatus::Completed
                    },
                    Some(
                        invocation
                            .map(|value| scalar_fields(value.get("arguments")))
                            .unwrap_or_default(),
                    ),
                    ended.then(|| detail(payload.get("result"))).flatten(),
                    failed
                        .then(|| {
                            object(payload.get("result"))
                                .and_then(|result| result.get("Err"))
                                .and_then(|value| detail(Some(value)))
                        })
                        .flatten(),
                    None,
                    Vec::new(),
                    at,
                );
            }
            "web_search_begin" | "web_search_end" => {
                let mut input = scalar_fields(payload.get("action"));
                if let Some(query) = nonempty(payload.get("query")) {
                    put_field(
                        &mut input,
                        "query",
                        AgentScalarValue::String {
                            value: query.to_owned(),
                        },
                    );
                }
                self.tool(
                    call_id,
                    "websearch".to_owned(),
                    if kind.ends_with("_end") {
                        AgentToolStatus::Completed
                    } else {
                        AgentToolStatus::Running
                    },
                    Some(input),
                    None,
                    None,
                    None,
                    Vec::new(),
                    at,
                );
            }
            "plan_update" => {
                let text = format_plan(payload);
                if !text.is_empty() {
                    self.put_part(
                        AgentTranscriptPart::Plan {
                            id: format!("plan:{}", self.sequence),
                            text,
                            timestamp_ms: at,
                        },
                        at,
                    );
                }
            }
            "error" | "warning" | "stream_error" | "deprecation_notice" => {
                let text = nonempty(payload.get("message"))
                    .or_else(|| nonempty(payload.get("summary")))
                    .map(str::to_owned)
                    .or_else(|| detail(Some(&Value::Object(payload.clone()))))
                    .unwrap_or_else(|| kind.to_owned());
                self.put_part(
                    AgentTranscriptPart::Notice {
                        id: format!("notice:{}", self.sequence),
                        level: if matches!(kind, "warning" | "deprecation_notice") {
                            AgentNoticeLevel::Warning
                        } else {
                            AgentNoticeLevel::Error
                        },
                        text,
                        timestamp_ms: at,
                    },
                    at,
                );
            }
            _ if kind.contains("approval_request")
                || kind.contains("request_user_input")
                || kind.contains("elicitation_request")
                || kind.contains("request_permissions") =>
            {
                self.put_part(AgentTranscriptPart::Notice { id: format!("notice:{}", self.sequence), level: AgentNoticeLevel::Info, text: "Codex is waiting for an interactive response. Open Terminal to respond.".to_owned(), timestamp_ms: at }, at);
            }
            _ => {}
        }
    }
}

#[derive(Clone, Debug)]
struct ParsedToolResult {
    output: Option<String>,
    error: Option<String>,
    exit_code: Option<i64>,
    process_id: Option<i64>,
    running: bool,
}

fn object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value?.as_object()
}
fn nonempty(value: Option<&Value>) -> Option<&str> {
    value?.as_str().filter(|value| !value.is_empty())
}

fn text_content(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(|value| {
                let value = value.as_object()?;
                nonempty(value.get("text"))
                    .or_else(|| nonempty(value.get("content")))
                    .map(str::to_owned)
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(Value::Object(value)) => {
            if let Some(content) = nonempty(value.get("content")) {
                return content.to_owned();
            }
            if let Some(items) = value.get("content_items") {
                return text_content(Some(items));
            }
            if let Some(items) = value.get("content") {
                return text_content(Some(items));
            }
            Value::Object(value.clone()).to_string()
        }
        Some(value) => value.to_string(),
        None => String::new(),
    }
}

fn detail(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::Null => None,
        Value::String(value) => Some(value.clone()),
        value => serde_json::to_string_pretty(value).ok(),
    }
}

fn timestamp_ms(value: Option<&Value>) -> Option<u64> {
    if let Some(number) = value.and_then(Value::as_u64) {
        return Some(number);
    }
    let text = value?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()?
        .timestamp_millis()
        .try_into()
        .ok()
}

fn injected_user_context(value: &str) -> bool {
    let value = value.trim_start();
    (value.starts_with("# AGENTS.md instructions for ") && value.contains("\n\n<INSTRUCTIONS>"))
        || (value.starts_with("<environment_context>") && value.ends_with("</environment_context>"))
}

fn canonical_tool_name(value: &str) -> String {
    match value.to_ascii_lowercase().as_str() {
        "exec" | "exec_command" | "command_execution" | "local_shell_call" | "bash" => {
            "shell".to_owned()
        }
        "apply_patch" | "turn_diff" => "patch".to_owned(),
        "web_search" | "web_search_call" => "websearch".to_owned(),
        "update_plan" => "todowrite".to_owned(),
        "" => "tool".to_owned(),
        value => value.to_owned(),
    }
}

fn command_title(value: Option<&Value>) -> String {
    match value {
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" "),
        Some(Value::String(value)) if !value.is_empty() => value.clone(),
        _ => "Command".to_owned(),
    }
}

fn parse_tool_status(value: Option<&Value>, fallback: AgentToolStatus) -> AgentToolStatus {
    let value = value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if ["fail", "error", "declin", "incomplete"]
        .iter()
        .any(|needle| value.contains(needle))
    {
        AgentToolStatus::Error
    } else if ["complete", "done", "success"]
        .iter()
        .any(|needle| value.contains(needle))
    {
        AgentToolStatus::Completed
    } else if ["running", "progress"]
        .iter()
        .any(|needle| value.contains(needle))
    {
        AgentToolStatus::Running
    } else if ["pending", "queued"]
        .iter()
        .any(|needle| value.contains(needle))
    {
        AgentToolStatus::Pending
    } else {
        fallback
    }
}

fn scalar_fields(value: Option<&Value>) -> Vec<AgentField> {
    object(value)
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| {
                    let value = match value {
                        Value::String(value) => AgentScalarValue::String {
                            value: value.clone(),
                        },
                        Value::Number(value) => AgentScalarValue::Number {
                            value: value.as_f64()?,
                        },
                        Value::Bool(value) => AgentScalarValue::Boolean { value: *value },
                        _ => return None,
                    };
                    Some(AgentField {
                        key: key.clone(),
                        value,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn fields<const N: usize>(values: [(&str, String); N]) -> Option<Vec<AgentField>> {
    Some(
        values
            .into_iter()
            .map(|(key, value)| AgentField {
                key: key.to_owned(),
                value: AgentScalarValue::String { value },
            })
            .collect(),
    )
}

fn put_field(fields: &mut Vec<AgentField>, key: &str, value: AgentScalarValue) {
    if let Some(field) = fields.iter_mut().find(|field| field.key == key) {
        field.value = value;
    } else {
        fields.push(AgentField {
            key: key.to_owned(),
            value,
        });
    }
}

fn fields_with_cwd(payload: &Map<String, Value>) -> Option<Vec<AgentField>> {
    let mut fields = fields([("command", command_title(payload.get("command")))]).unwrap();
    if let Some(cwd) = nonempty(payload.get("cwd")) {
        put_field(
            &mut fields,
            "cwd",
            AgentScalarValue::String {
                value: cwd.to_owned(),
            },
        );
    }
    Some(fields)
}

fn source_tool_name(source: &str) -> Option<&str> {
    let marker = "tools.";
    let start = source.find(marker)? + marker.len();
    let rest = &source[start..];
    let end =
        rest.find(|character: char| !character.is_ascii_alphanumeric() && character != '_')?;
    Some(&rest[..end])
}

fn quoted_field(source: &str, key: &str) -> Option<String> {
    for prefix in [format!("\"{key}\":"), format!("{key}:")] {
        let mut rest = source.split_once(&prefix)?.1.trim_start();
        if !rest.starts_with('"') {
            continue;
        }
        rest = &rest[1..];
        let mut escaped = false;
        for (index, character) in rest.char_indices() {
            if character == '"' && !escaped {
                return serde_json::from_str::<String>(&format!("\"{}\"", &rest[..index])).ok();
            }
            escaped = character == '\\' && !escaped;
            if character != '\\' {
                escaped = false;
            }
        }
    }
    None
}

fn numeric_field(source: &str, key: &str) -> Option<i64> {
    let (_, rest) = source.split_once(&format!("{key}:"))?;
    rest.trim_start()
        .split(|character: char| !character.is_ascii_digit() && character != '-')
        .next()?
        .parse()
        .ok()
}

fn translate_tool(
    name: &str,
    raw: Option<&Value>,
) -> (
    String,
    Vec<AgentField>,
    Option<i64>,
    bool,
    Vec<AgentFileDiff>,
) {
    if name != "exec" || !matches!(raw, Some(Value::String(_))) {
        let tool = canonical_tool_name(name);
        let mut fields = scalar_fields(raw);
        if tool == "shell"
            && !fields.iter().any(|field| field.key == "command")
            && let Some(command) = object(raw)
                .and_then(|value| value.get("cmd"))
                .map(|value| command_title(Some(value)))
        {
            put_field(
                &mut fields,
                "command",
                AgentScalarValue::String { value: command },
            );
        }
        return (tool, fields, None, false, Vec::new());
    }
    let source = raw.and_then(Value::as_str).unwrap_or_default();
    match source_tool_name(source).unwrap_or(name) {
        "exec_command" => {
            let mut input = Vec::new();
            if let Some(command) = quoted_field(source, "cmd") {
                put_field(
                    &mut input,
                    "command",
                    AgentScalarValue::String { value: command },
                );
            }
            if let Some(cwd) = quoted_field(source, "workdir") {
                put_field(&mut input, "cwd", AgentScalarValue::String { value: cwd });
            }
            ("shell".to_owned(), input, None, false, Vec::new())
        }
        "write_stdin" => (
            "shell".to_owned(),
            Vec::new(),
            numeric_field(source, "session_id"),
            true,
            Vec::new(),
        ),
        "apply_patch" => (
            "patch".to_owned(),
            Vec::new(),
            None,
            false,
            apply_patch_files(source),
        ),
        "update_plan" => ("todowrite".to_owned(), Vec::new(), None, false, Vec::new()),
        "web__run" => {
            let query = quoted_field(source, "q").unwrap_or_else(|| "Web search".to_owned());
            (
                "websearch".to_owned(),
                fields([("query", query)]).unwrap(),
                None,
                false,
                Vec::new(),
            )
        }
        nested => (
            canonical_tool_name(nested),
            scalar_fields(raw),
            None,
            false,
            Vec::new(),
        ),
    }
}

fn tool_result(value: Option<&Value>) -> ParsedToolResult {
    let texts = match value {
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(|value| {
                object(Some(value))
                    .and_then(|value| nonempty(value.get("text")))
                    .map(str::to_owned)
            })
            .collect(),
        _ => vec![text_content(value)],
    };
    for text in &texts {
        if let Ok(Value::Object(result)) = serde_json::from_str::<Value>(text) {
            let exit_code = result.get("exit_code").and_then(Value::as_i64);
            let process_id = result.get("session_id").and_then(Value::as_i64);
            return ParsedToolResult {
                output: nonempty(result.get("output")).map(str::to_owned),
                error: exit_code
                    .filter(|code| *code != 0)
                    .map(|code| format!("Exited with code {code}")),
                exit_code,
                process_id,
                running: process_id.is_some() && exit_code.is_none(),
            };
        }
    }
    let joined = texts.join("");
    let failed = joined.contains("Script failed") || joined.contains("Script error:");
    let output = joined
        .split_once("Output:\n")
        .map(|(_, output)| output)
        .unwrap_or(&joined)
        .trim()
        .to_owned();
    ParsedToolResult {
        output: (!output.is_empty() && output != "{}").then_some(output.clone()),
        error: failed.then_some(if output.is_empty() {
            "Tool failed".to_owned()
        } else {
            output
        }),
        exit_code: None,
        process_id: None,
        running: false,
    }
}

fn format_plan(payload: &Map<String, Value>) -> String {
    let mut parts = nonempty(payload.get("explanation"))
        .map(str::to_owned)
        .into_iter()
        .collect::<Vec<_>>();
    if let Some(plan) = payload.get("plan").and_then(Value::as_array) {
        parts.extend(plan.iter().filter_map(|value| {
            let value = value.as_object()?;
            let step = nonempty(value.get("step"))?;
            Some(format!(
                "- [{}] {step}",
                if value.get("status").and_then(Value::as_str) == Some("completed") {
                    "x"
                } else {
                    " "
                }
            ))
        }));
    }
    parts.join("\n\n")
}

fn diff_counts(patch: &str) -> (u32, u32) {
    patch.lines().fold((0, 0), |(additions, deletions), line| {
        (
            additions + u32::from(line.starts_with('+') && !line.starts_with("+++")),
            deletions + u32::from(line.starts_with('-') && !line.starts_with("---")),
        )
    })
}

fn legacy_change_files(value: Option<&Value>) -> Vec<AgentFileDiff> {
    object(value)
        .map(|changes| {
            changes
                .iter()
                .map(|(file, value)| {
                    let value = value.as_object();
                    let patch = value
                        .and_then(|value| {
                            nonempty(value.get("diff")).or_else(|| nonempty(value.get("patch")))
                        })
                        .map(str::to_owned);
                    let (additions, deletions) = diff_counts(patch.as_deref().unwrap_or_default());
                    AgentFileDiff {
                        file: file.clone(),
                        patch,
                        before: value
                            .and_then(|value| nonempty(value.get("before")))
                            .map(str::to_owned),
                        after: value
                            .and_then(|value| nonempty(value.get("after")))
                            .map(str::to_owned),
                        additions: Some(additions),
                        deletions: Some(deletions),
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

fn unified_diff_files(value: Option<&str>) -> Vec<AgentFileDiff> {
    let Some(value) = value else {
        return Vec::new();
    };
    let mut starts = value.match_indices("diff --git a/").collect::<Vec<_>>();
    if starts.is_empty() {
        let file = value
            .lines()
            .find_map(|line| {
                line.strip_prefix("+++ b/")
                    .or_else(|| line.strip_prefix("--- a/"))
            })
            .unwrap_or("Changes");
        let (additions, deletions) = diff_counts(value);
        return vec![AgentFileDiff {
            file: file.to_owned(),
            patch: Some(value.to_owned()),
            before: None,
            after: None,
            additions: Some(additions),
            deletions: Some(deletions),
        }];
    }
    starts.push((value.len(), ""));
    starts
        .windows(2)
        .filter_map(|window| {
            let start = window[0].0;
            let end = window[1].0;
            let patch = value[start..end].trim_end().to_owned();
            let first = patch.lines().next()?;
            let file = first.split_once(" b/")?.1.to_owned();
            let (additions, deletions) = diff_counts(&patch);
            Some(AgentFileDiff {
                file,
                patch: Some(patch),
                before: None,
                after: None,
                additions: Some(additions),
                deletions: Some(deletions),
            })
        })
        .collect()
}

fn apply_patch_files(source: &str) -> Vec<AgentFileDiff> {
    let Some(begin) = source.find("*** Begin Patch") else {
        return Vec::new();
    };
    let decoded = source[begin..].replace("\\n", "\n").replace("\\\"", "\"");
    let mut result = Vec::new();
    let mut current: Option<(String, String)> = None;
    for line in decoded.lines() {
        if let Some(file) = line
            .strip_prefix("*** Update File: ")
            .or_else(|| line.strip_prefix("*** Add File: "))
            .or_else(|| line.strip_prefix("*** Delete File: "))
        {
            if let Some((file, patch)) = current.take() {
                let (additions, deletions) = diff_counts(&patch);
                result.push(AgentFileDiff {
                    file,
                    patch: Some(patch.trim_end().to_owned()),
                    before: None,
                    after: None,
                    additions: Some(additions),
                    deletions: Some(deletions),
                });
            }
            current = Some((file.trim().to_owned(), String::new()));
        } else if let Some((_, patch)) = current.as_mut() {
            patch.push_str(line);
            patch.push('\n');
        }
    }
    if let Some((file, patch)) = current {
        let (additions, deletions) = diff_counts(&patch);
        result.push(AgentFileDiff {
            file,
            patch: Some(patch.trim_end().to_owned()),
            before: None,
            after: None,
            additions: Some(additions),
            deletions: Some(deletions),
        });
    }
    result
}

fn project_turns(messages: &[AgentTranscriptMessage]) -> Vec<AgentTranscriptTurn> {
    let mut turns = Vec::<AgentTranscriptTurn>::new();
    let mut by_user = HashMap::<String, usize>::new();
    let mut latest = None;
    for message in messages {
        if message.role == AgentMessageRole::User {
            let index = turns.len();
            turns.push(AgentTranscriptTurn {
                id: message.id.clone(),
                user_message_id: Some(message.id.clone()),
                assistant_message_ids: Vec::new(),
                status: AgentTurnStatus::Idle,
                started_at_ms: message.created_at_ms,
                completed_at_ms: message.completed_at_ms,
                diffs: message.diffs.clone(),
            });
            by_user.insert(message.id.clone(), index);
            latest = Some(index);
            continue;
        }
        let index = message
            .parent_id
            .as_ref()
            .and_then(|parent| by_user.get(parent).copied())
            .or(latest)
            .unwrap_or_else(|| {
                let index = turns.len();
                turns.push(AgentTranscriptTurn {
                    id: message
                        .parent_id
                        .clone()
                        .unwrap_or_else(|| message.id.clone()),
                    user_message_id: None,
                    assistant_message_ids: Vec::new(),
                    status: AgentTurnStatus::Idle,
                    started_at_ms: message.created_at_ms,
                    completed_at_ms: None,
                    diffs: Vec::new(),
                });
                index
            });
        latest = Some(index);
        let turn = &mut turns[index];
        turn.assistant_message_ids.push(message.id.clone());
        turn.started_at_ms = turn.started_at_ms.or(message.created_at_ms);
        if let Some(completed) = message.completed_at_ms {
            turn.completed_at_ms = Some(turn.completed_at_ms.unwrap_or(0).max(completed));
        }
        for diff in &message.diffs {
            if let Some(current) = turn
                .diffs
                .iter_mut()
                .find(|current| current.file == diff.file)
            {
                *current = diff.clone();
            } else {
                turn.diffs.push(diff.clone());
            }
        }
    }
    for turn in &mut turns {
        let mut running = false;
        let mut failed = false;
        for id in &turn.assistant_message_ids {
            let Some(message) = messages.iter().find(|message| &message.id == id) else {
                continue;
            };
            failed |= message.error.is_some();
            for part in &message.parts {
                if let AgentTranscriptPart::Tool { state, .. } = part {
                    running |= matches!(
                        state.status,
                        AgentToolStatus::Pending | AgentToolStatus::Running
                    );
                    failed |= state.status == AgentToolStatus::Error;
                    if let Some(completed) = state.completed_at_ms {
                        turn.completed_at_ms =
                            Some(turn.completed_at_ms.unwrap_or(0).max(completed));
                    }
                }
            }
        }
        turn.status = if failed {
            AgentTurnStatus::Error
        } else if running {
            AgentTurnStatus::Working
        } else {
            AgentTurnStatus::Idle
        };
    }
    turns
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct CachedCodexLine {
    raw_line: String,
    end_offset: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct CachedCodexSession {
    schema_version: u32,
    requested_session_id: String,
    source: Option<CodexSourceIdentity>,
    committed_offset: u64,
    lines: Vec<CachedCodexLine>,
    transcript: AgentTranscriptState,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum AgentCacheError {
    #[error("agent transcript cache is malformed: {0}")]
    Malformed(String),
    #[error("agent transcript cache belongs to a different session")]
    SessionMismatch,
    #[error("agent transcript cache raw replay diverged from its projection")]
    ReplayDiverged,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodexBindResult {
    pub source_generation: u64,
    pub start_offset: u64,
    pub rebuilt: bool,
}

#[derive(Clone, Debug)]
pub struct CodexIngestResult {
    pub source_generation: u64,
    pub received_offset: u64,
    pub committable_offset: u64,
    pub malformed_records: u32,
    pub changed: bool,
}

/// Pure state machine shared by live sessions and deterministic tests. Remote
/// I/O and durable blob storage are intentionally injected around this core.
#[derive(Clone, Debug)]
pub struct CodexSessionCore {
    requested_session_id: String,
    source: Option<CodexSourceIdentity>,
    source_generation: u64,
    revision: u64,
    adapter: CodexTranscriptAdapter,
    framer: TranscriptJsonlFramer,
    cached_lines: Vec<CachedCodexLine>,
    committed_offset: u64,
    status: AgentTranscriptStatus,
    error: Option<String>,
}

impl CodexSessionCore {
    pub fn new(session_id: impl Into<String>) -> Self {
        let session_id = session_id.into();
        Self {
            requested_session_id: session_id.clone(),
            source: None,
            source_generation: 0,
            revision: 0,
            adapter: CodexTranscriptAdapter::new(session_id),
            framer: TranscriptJsonlFramer::default(),
            cached_lines: Vec::new(),
            committed_offset: 0,
            status: AgentTranscriptStatus::Loading,
            error: None,
        }
    }

    pub fn source_generation(&self) -> u64 {
        self.source_generation
    }

    pub fn committed_offset(&self) -> u64 {
        self.committed_offset
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn received_offset(&self) -> u64 {
        self.framer.received_offset()
    }

    pub fn state(&self) -> AgentTranscriptState {
        self.adapter
            .snapshot(self.revision, self.status, self.error.clone())
    }

    pub fn mark_stale(&mut self, error: impl Into<String>) -> AgentTranscriptState {
        self.status = if self.cached_lines.is_empty() {
            AgentTranscriptStatus::Error
        } else {
            AgentTranscriptStatus::Stale
        };
        self.error = Some(error.into());
        self.bump_revision();
        self.state()
    }

    pub fn mark_unavailable(&mut self, error: impl Into<String>) -> AgentTranscriptState {
        self.status = if self.cached_lines.is_empty() {
            AgentTranscriptStatus::Unavailable
        } else {
            AgentTranscriptStatus::Stale
        };
        self.error = Some(error.into());
        self.bump_revision();
        self.state()
    }

    pub fn mark_live(&mut self) -> AgentTranscriptState {
        if self.status != AgentTranscriptStatus::Live || self.error.is_some() {
            self.status = AgentTranscriptStatus::Live;
            self.error = None;
            self.bump_revision();
        }
        self.state()
    }

    pub fn close(&mut self) -> AgentTranscriptState {
        self.source_generation = self.source_generation.saturating_add(1);
        self.status = AgentTranscriptStatus::Closed;
        self.error = None;
        self.bump_revision();
        self.state()
    }

    pub fn restore_cache(&mut self, bytes: &[u8]) -> Result<AgentTranscriptState, AgentCacheError> {
        let cached: CachedCodexSession = serde_json::from_slice(bytes)
            .map_err(|error| AgentCacheError::Malformed(error.to_string()))?;
        if cached.schema_version != 1 {
            return Err(AgentCacheError::Malformed("unsupported schema".to_owned()));
        }
        if cached.requested_session_id != self.requested_session_id {
            return Err(AgentCacheError::SessionMismatch);
        }
        if cached.committed_offset > 0
            && cached.lines.last().map(|line| line.end_offset) != Some(cached.committed_offset)
        {
            return Err(AgentCacheError::Malformed(
                "raw lines do not cover committed cursor".to_owned(),
            ));
        }
        let mut previous = 0;
        let mut adapter = CodexTranscriptAdapter::new(self.requested_session_id.clone());
        for line in &cached.lines {
            if line.end_offset <= previous || line.end_offset > cached.committed_offset {
                return Err(AgentCacheError::Malformed(
                    "raw line offsets are invalid".to_owned(),
                ));
            }
            previous = line.end_offset;
            if let Ok(value) = serde_json::from_str::<Value>(&line.raw_line) {
                adapter.accept(&value);
            }
        }
        let replay = adapter.snapshot(
            cached.transcript.revision,
            cached.transcript.status,
            cached.transcript.error.clone(),
        );
        if replay.info != cached.transcript.info
            || replay.messages != cached.transcript.messages
            || replay.turns != cached.transcript.turns
        {
            return Err(AgentCacheError::ReplayDiverged);
        }
        self.source = cached.source;
        self.committed_offset = cached.committed_offset;
        self.cached_lines = cached.lines;
        self.adapter = adapter;
        self.revision = cached.transcript.revision;
        self.status = AgentTranscriptStatus::Stale;
        self.error = None;
        self.framer = TranscriptJsonlFramer::with_offset(self.committed_offset);
        self.bump_revision();
        Ok(self.state())
    }

    pub fn cache_blob(&self) -> Result<Vec<u8>, AgentCacheError> {
        let committable = self.framer.committable_offset();
        let lines = self
            .cached_lines
            .iter()
            .filter(|line| line.end_offset <= committable)
            .cloned()
            .collect::<Vec<_>>();
        let transcript = self.state();
        serde_json::to_vec(&CachedCodexSession {
            schema_version: 1,
            requested_session_id: self.requested_session_id.clone(),
            source: self.source.clone(),
            committed_offset: committable,
            lines,
            transcript,
        })
        .map_err(|error| AgentCacheError::Malformed(error.to_string()))
    }

    pub fn confirm_cache(&mut self, source_generation: u64, offset: u64) -> bool {
        if source_generation != self.source_generation
            || offset < self.committed_offset
            || offset > self.framer.committable_offset()
        {
            return false;
        }
        self.committed_offset = offset;
        true
    }

    pub fn bind_source(
        &mut self,
        path: String,
        file_id: String,
        remote_size: u64,
    ) -> CodexBindResult {
        let next = CodexSourceIdentity {
            requested_session_id: self.requested_session_id.clone(),
            rollout_path: path,
            file_id,
        };
        self.source_generation = self.source_generation.saturating_add(1);
        // In-process reconnects may happen after records were incorporated but
        // before the platform cache write was confirmed. Resume after the last
        // complete handled line, while keeping committed_offset as the durable
        // crash-recovery checkpoint.
        let resume_offset = self.framer.committable_offset();
        let warm = self.source.as_ref() == Some(&next) && remote_size >= resume_offset;
        if warm {
            self.framer = TranscriptJsonlFramer::with_offset(resume_offset);
        } else {
            self.adapter = CodexTranscriptAdapter::new(self.requested_session_id.clone());
            self.cached_lines.clear();
            self.committed_offset = 0;
            self.framer.reset(0);
            self.bump_revision();
        }
        self.source = Some(next);
        self.status = AgentTranscriptStatus::Loading;
        self.error = None;
        CodexBindResult {
            source_generation: self.source_generation,
            start_offset: if warm { resume_offset } else { 0 },
            rebuilt: !warm,
        }
    }

    pub fn ingest(
        &mut self,
        source_generation: u64,
        bytes: &[u8],
    ) -> Result<CodexIngestResult, TranscriptParseError> {
        if source_generation != self.source_generation {
            return Ok(CodexIngestResult {
                source_generation,
                received_offset: self.framer.received_offset(),
                committable_offset: self.framer.committable_offset(),
                malformed_records: 0,
                changed: false,
            });
        }
        let lines = self.framer.push(bytes)?;
        let mut changed = false;
        let mut malformed_records = 0;
        for line in lines {
            self.cached_lines.push(CachedCodexLine {
                raw_line: line.raw_line,
                end_offset: line.end_offset,
            });
            match line.parsed {
                Ok(Value::Null) => {}
                Ok(value) => changed |= self.adapter.accept(&value),
                Err(_) => malformed_records += 1,
            }
        }
        if changed {
            self.status = AgentTranscriptStatus::Live;
            self.error = None;
            self.bump_revision();
        }
        Ok(CodexIngestResult {
            source_generation,
            received_offset: self.framer.received_offset(),
            committable_offset: self.framer.committable_offset(),
            malformed_records,
            changed,
        })
    }

    fn bump_revision(&mut self) {
        self.revision = self.revision.saturating_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(kind: &str, payload: Value) -> Vec<u8> {
        format!("{}\n", serde_json::json!({"timestamp":"2026-08-24T12:00:00.000Z","type":kind,"payload":payload})).into_bytes()
    }

    fn text_parts(state: &AgentTranscriptState, role: AgentMessageRole) -> Vec<String> {
        state
            .messages
            .iter()
            .filter(|message| message.role == role)
            .flat_map(|message| message.parts.iter())
            .filter_map(|part| match part {
                AgentTranscriptPart::Text { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn jsonl_chunk_boundaries_are_semantically_irrelevant() {
        let bytes = [
            record(
                "event_msg",
                serde_json::json!({"type":"user_message","message":"hello"}),
            ),
            record(
                "event_msg",
                serde_json::json!({"type":"agent_message","message":"world"}),
            ),
        ]
        .concat();
        let mut whole = TranscriptJsonlFramer::default();
        let expected = whole.push(&bytes).unwrap();
        for split in 0..=bytes.len() {
            let mut chunked = TranscriptJsonlFramer::default();
            let mut actual = chunked.push(&bytes[..split]).unwrap();
            actual.extend(chunked.push(&bytes[split..]).unwrap());
            assert_eq!(actual, expected, "split {split}");
            assert_eq!(chunked.committable_offset(), bytes.len() as u64);
        }
    }

    #[test]
    fn partial_and_malformed_lines_do_not_advance_committable_offset() {
        let valid = record(
            "event_msg",
            serde_json::json!({"type":"user_message","message":"hello"}),
        );
        let mut framer = TranscriptJsonlFramer::default();
        framer.push(&valid).unwrap();
        let committed = framer.committable_offset();
        framer.push(b"{\"partial\":").unwrap();
        assert_eq!(framer.committable_offset(), committed);
        let lines = framer.push(b"nope}\n").unwrap();
        assert!(lines[0].parsed.is_err());
        assert_eq!(framer.committable_offset(), committed);
    }

    #[test]
    fn fragmented_utf8_and_crlf_are_supported() {
        let bytes = "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"你好\"}}\r\n".as_bytes();
        let split = bytes.iter().position(|byte| *byte >= 0x80).unwrap() + 1;
        let mut framer = TranscriptJsonlFramer::default();
        assert!(framer.push(&bytes[..split]).unwrap().is_empty());
        let lines = framer.push(&bytes[split..]).unwrap();
        assert!(lines[0].parsed.is_ok());
    }

    #[test]
    fn invalid_utf8_and_oversized_line_are_rejected_without_panic() {
        let mut framer = TranscriptJsonlFramer::default();
        assert_eq!(
            framer.push(&[0xff, b'\n']).unwrap_err(),
            TranscriptParseError::InvalidUtf8
        );
        let mut framer = TranscriptJsonlFramer::default();
        assert_eq!(
            framer
                .push(&vec![b'x'; MAX_TRANSCRIPT_LINE_BYTES + 1])
                .unwrap_err(),
            TranscriptParseError::LineTooLarge
        );
    }

    #[test]
    fn codex_messages_deduplicate_and_hide_injected_context() {
        let mut adapter = CodexTranscriptAdapter::new("requested");
        for value in [
            serde_json::json!({"type":"session_meta","payload":{"id":"thread","cwd":"/repo"}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":"hello"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","id":"u1","role":"user","content":[{"text":"hello"}]}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","id":"context","role":"user","content":[{"text":"# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nsecret\n</INSTRUCTIONS>"}]}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"agent_message","message":"done"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","id":"a1","role":"assistant","content":[{"text":"done"}]}}),
        ] {
            adapter.accept(&value);
        }
        let state = adapter.snapshot(1, AgentTranscriptStatus::Live, None);
        assert_eq!(state.session_id, "thread");
        assert_eq!(
            state.info.as_ref().unwrap().directory.as_deref(),
            Some("/repo")
        );
        assert_eq!(text_parts(&state, AgentMessageRole::User), ["hello"]);
        assert_eq!(text_parts(&state, AgentMessageRole::Assistant), ["done"]);
        assert_eq!(state.turns.len(), 1);
    }

    #[test]
    fn reasoning_exposes_summary_but_not_raw_content() {
        let mut adapter = CodexTranscriptAdapter::new("thread");
        adapter.accept(&serde_json::json!({"type":"response_item","payload":{"type":"reasoning","id":"r1","summary":[{"text":"Checked the failure."}],"content":[{"text":"hidden chain"}]}}));
        adapter.accept(&serde_json::json!({"type":"event_msg","payload":{"type":"agent_reasoning_raw_content","text":"also hidden"}}));
        let state = adapter.snapshot(1, AgentTranscriptStatus::Live, None);
        let reasoning = state
            .messages
            .iter()
            .flat_map(|message| &message.parts)
            .filter_map(|part| match part {
                AgentTranscriptPart::Reasoning { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(reasoning, ["Checked the failure."]);
    }

    #[test]
    fn tool_lifecycle_retains_stable_identity() {
        let mut adapter = CodexTranscriptAdapter::new("thread");
        adapter.accept(&serde_json::json!({"type":"response_item","payload":{"type":"custom_tool_call","call_id":"call_1","name":"exec","input":{"cmd":"git status"}}}));
        adapter.accept(&serde_json::json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call_1","output":"clean"}}));
        let state = adapter.snapshot(1, AgentTranscriptStatus::Live, None);
        let tools = state
            .messages
            .iter()
            .flat_map(|message| &message.parts)
            .filter_map(|part| match part {
                AgentTranscriptPart::Tool { id, state, .. } => Some((id, state)),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].0, "tool:call_1");
        assert_eq!(tools[0].1.status, AgentToolStatus::Completed);
        assert_eq!(tools[0].1.output.as_deref(), Some("clean"));
    }

    #[test]
    fn full_and_incremental_parsing_produce_equal_transcripts() {
        let bytes = [
            record(
                "event_msg",
                serde_json::json!({"type":"user_message","message":"hello"}),
            ),
            record(
                "event_msg",
                serde_json::json!({"type":"agent_message","message":"done"}),
            ),
        ]
        .concat();
        let parse = |chunks: Vec<&[u8]>| {
            let mut framer = TranscriptJsonlFramer::default();
            let mut adapter = CodexTranscriptAdapter::new("thread");
            for chunk in chunks {
                for line in framer.push(chunk).unwrap() {
                    if let Ok(value) = line.parsed
                        && !value.is_null()
                    {
                        adapter.accept(&value);
                    }
                }
            }
            adapter.snapshot(1, AgentTranscriptStatus::Live, None)
        };
        let full = parse(vec![&bytes]);
        for split in 0..=bytes.len() {
            assert_eq!(parse(vec![&bytes[..split], &bytes[split..]]), full);
        }
    }

    #[test]
    fn source_identity_distinguishes_path_file_and_session() {
        let source = CodexSourceIdentity {
            requested_session_id: "a".into(),
            rollout_path: "/a".into(),
            file_id: "1:2".into(),
        };
        assert_ne!(
            source,
            CodexSourceIdentity {
                rollout_path: "/b".into(),
                ..source.clone()
            }
        );
        assert_ne!(
            source,
            CodexSourceIdentity {
                file_id: "2:3".into(),
                ..source.clone()
            }
        );
        assert_ne!(
            source.clone(),
            CodexSourceIdentity {
                requested_session_id: "b".into(),
                ..source.clone()
            }
        );
    }

    #[test]
    fn checkpoint_advances_only_after_explicit_durable_confirmation() {
        let mut core = CodexSessionCore::new("thread");
        let binding = core.bind_source("/rollout".into(), "1:2".into(), 0);
        let complete = record(
            "event_msg",
            serde_json::json!({"type":"user_message","message":"one"}),
        );
        core.ingest(binding.source_generation, &complete).unwrap();
        core.ingest(binding.source_generation, b"{\"partial\":")
            .unwrap();
        assert_eq!(core.committed_offset(), 0);
        assert_eq!(core.state().messages.len(), 1);
        let committable = core.framer.committable_offset();
        assert_eq!(committable, complete.len() as u64);
        assert!(core.confirm_cache(binding.source_generation, committable));
        assert_eq!(core.committed_offset(), complete.len() as u64);
    }

    #[test]
    fn cache_round_trip_replays_raw_lines_and_resumes_incrementally() {
        let first = record(
            "event_msg",
            serde_json::json!({"type":"user_message","message":"one"}),
        );
        let second = record(
            "event_msg",
            serde_json::json!({"type":"agent_message","message":"two"}),
        );
        let mut core = CodexSessionCore::new("thread");
        let binding = core.bind_source("/rollout".into(), "1:2".into(), first.len() as u64);
        core.ingest(binding.source_generation, &first).unwrap();
        let cursor = core.framer.committable_offset();
        let blob = core.cache_blob().unwrap();
        assert!(core.confirm_cache(binding.source_generation, cursor));

        let mut restored = CodexSessionCore::new("thread");
        restored.restore_cache(&blob).unwrap();
        let binding = restored.bind_source(
            "/rollout".into(),
            "1:2".into(),
            (first.len() + second.len()) as u64,
        );
        assert_eq!(binding.start_offset, first.len() as u64);
        restored.ingest(binding.source_generation, &second).unwrap();

        let mut full = CodexSessionCore::new("thread");
        let binding = full.bind_source(
            "/rollout".into(),
            "1:2".into(),
            (first.len() + second.len()) as u64,
        );
        full.ingest(binding.source_generation, &[first, second].concat())
            .unwrap();
        assert_eq!(restored.state().messages, full.state().messages);
        assert_eq!(restored.state().turns, full.state().turns);
    }

    #[test]
    fn reconnect_before_cache_confirmation_does_not_replay_incorporated_records() {
        let first = record(
            "event_msg",
            serde_json::json!({"type":"user_message","message":"one"}),
        );
        let mut core = CodexSessionCore::new("thread");
        let binding = core.bind_source("/rollout".into(), "1:2".into(), first.len() as u64);
        core.ingest(binding.source_generation, &first).unwrap();
        assert_eq!(core.committed_offset(), 0);

        let rebound = core.bind_source("/rollout".into(), "1:2".into(), first.len() as u64);
        assert!(!rebound.rebuilt);
        assert_eq!(rebound.start_offset, first.len() as u64);
        assert_eq!(text_parts(&core.state(), AgentMessageRole::User), ["one"]);
    }

    #[test]
    fn replacement_truncation_and_stale_generation_are_isolated() {
        let first = record(
            "event_msg",
            serde_json::json!({"type":"user_message","message":"old"}),
        );
        let mut core = CodexSessionCore::new("thread");
        let old = core.bind_source("/rollout".into(), "1:2".into(), first.len() as u64);
        core.ingest(old.source_generation, &first).unwrap();
        let cursor = core.framer.committable_offset();
        core.confirm_cache(old.source_generation, cursor);

        let replacement = core.bind_source("/rollout".into(), "9:9".into(), 0);
        assert!(replacement.rebuilt);
        assert_eq!(replacement.start_offset, 0);
        assert!(core.state().messages.is_empty());
        let stale = core
            .ingest(old.source_generation, &first)
            .expect("stale input is harmless");
        assert!(!stale.changed);
        assert!(core.state().messages.is_empty());
    }

    #[test]
    fn transient_failure_retains_cached_transcript() {
        let first = record(
            "event_msg",
            serde_json::json!({"type":"user_message","message":"offline"}),
        );
        let mut core = CodexSessionCore::new("thread");
        let binding = core.bind_source("/rollout".into(), "1:2".into(), first.len() as u64);
        core.ingest(binding.source_generation, &first).unwrap();
        let state = core.mark_stale("network unavailable");
        assert_eq!(state.status, AgentTranscriptStatus::Stale);
        assert_eq!(text_parts(&state, AgentMessageRole::User), ["offline"]);
    }

    #[test]
    fn unavailable_source_is_distinct_from_a_successful_empty_transcript() {
        let mut core = CodexSessionCore::new("thread");
        let state = core.mark_unavailable("rollout not created");
        assert_eq!(state.status, AgentTranscriptStatus::Unavailable);
        assert!(state.messages.is_empty());
        assert_eq!(state.error.as_deref(), Some("rollout not created"));
    }
}
