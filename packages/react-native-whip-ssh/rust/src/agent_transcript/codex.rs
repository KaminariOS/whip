//! Codex JSONL framing, wire adaptation, caching, and incremental session core.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::codex::rollout_wire::{Event as CodexEvent, ResponseItem as CodexResponseItem};
use crate::codex::{CodexRolloutReducer, RolloutRecord, decode_rollout_record};

use super::model::*;
#[cfg(test)]
use super::opencode::OpenCodeSessionCore;
use super::projection::*;

pub const MAX_TRANSCRIPT_LINE_BYTES: usize = 4 * 1024 * 1024;

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
    recent_messages: HashMap<String, (String, u64, bool)>,
    sequence: u64,
    active_user_message_id: Option<String>,
    active_assistant_message_id: Option<String>,
    rollout_reducer: CodexRolloutReducer,
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
            rollout_reducer: CodexRolloutReducer::default(),
        }
    }

    pub fn accept(&mut self, value: &Value) -> bool {
        self.accept_incremental(value).handled
    }

    fn accept_incremental(&mut self, value: &Value) -> CodexAdapterUpdate {
        let previous_session_id = self.session_id.clone();
        let previous_directory = self.directory.clone();
        let was_authoritative = self.rollout_reducer.is_authoritative();
        self.sequence = self.sequence.saturating_add(1);
        let decoded = decode_rollout_record(value);
        let record = value.as_object();
        let at = timestamp_ms(record.and_then(|record| record.get("timestamp")));
        let projection = self.rollout_reducer.accept(&decoded, at, self.sequence);
        let handled = match &decoded {
            RolloutRecord::SessionMeta(payload) => {
                if let Some(id) = payload.id.as_ref().filter(|id| !id.is_empty()) {
                    self.session_id.clone_from(id);
                }
                if let Some(cwd) = payload.cwd.as_ref().filter(|cwd| !cwd.is_empty()) {
                    self.directory = Some(cwd.clone());
                }
                true
            }
            RolloutRecord::TurnContext(context) => {
                if let Some(cwd) = context.cwd.as_ref().filter(|cwd| !cwd.is_empty()) {
                    self.directory = Some(cwd.clone());
                }
                true
            }
            RolloutRecord::Event(CodexEvent::ItemCompleted(completed)) => {
                if !completed.thread_id.is_empty() {
                    self.session_id.clone_from(&completed.thread_id);
                }
                true
            }
            RolloutRecord::Event(CodexEvent::Legacy(payload)) => {
                if let Some(payload) = payload.as_object() {
                    self.accept_event(payload, at);
                }
                true
            }
            RolloutRecord::ResponseItem(CodexResponseItem::Known { value }) => {
                if let Some(payload) = value.as_object() {
                    self.accept_response(payload, at);
                }
                true
            }
            RolloutRecord::Event(CodexEvent::TurnStarted(_)) => {
                if !self.rollout_reducer.is_authoritative() {
                    self.begin_turn();
                }
                true
            }
            RolloutRecord::Event(CodexEvent::TurnComplete(_)) => {
                if !self.rollout_reducer.is_authoritative() {
                    if let Some(id) = self.active_assistant_message_id.clone()
                        && let Some(message) = self.message_mut(&id)
                    {
                        message.completed_at_ms = at;
                    }
                    self.begin_turn();
                }
                true
            }
            RolloutRecord::Event(CodexEvent::ThreadRolledBack(rollback)) => {
                if !self.rollout_reducer.is_authoritative() {
                    self.rollback_legacy(rollback.num_turns);
                }
                true
            }
            RolloutRecord::Event(CodexEvent::TurnAborted(_)) | RolloutRecord::Compacted(_) => true,
            RolloutRecord::AppServerLike(value) => {
                if let Some(record) = value.as_object() {
                    match nonempty(record.get("type")) {
                        Some("thread.started") => {
                            if let Some(id) = nonempty(record.get("thread_id")).or_else(|| {
                                object(record.get("thread"))
                                    .and_then(|thread| nonempty(thread.get("id")))
                            }) {
                                id.clone_into(&mut self.session_id);
                            }
                            true
                        }
                        Some("item.completed") => {
                            if let Some(item) = object(record.get("item")) {
                                self.accept_completed_item(item, at);
                            }
                            true
                        }
                        _ => false,
                    }
                } else {
                    false
                }
            }
            RolloutRecord::KnownIrrelevant
            | RolloutRecord::Event(CodexEvent::KnownIrrelevant | CodexEvent::Unknown { .. })
            | RolloutRecord::ResponseItem(CodexResponseItem::Unknown { .. })
            | RolloutRecord::Unknown { .. } => false,
        };
        let mut deltas = Vec::new();
        let info_changed =
            previous_session_id != self.session_id || previous_directory != self.directory;
        if info_changed {
            deltas.push(AgentTranscriptDelta::InfoChanged {
                info: Some(self.info()),
            });
        }
        let reset = projection.became_authoritative || (!was_authoritative && handled);
        if self.rollout_reducer.is_authoritative() && !reset {
            if let Some(length) = projection.messages_truncated_to {
                deltas.push(AgentTranscriptDelta::MessagesTruncated {
                    length: u32::try_from(length).unwrap_or(u32::MAX),
                });
            }
            for index in projection.message_indexes {
                if let Some(message) = self.rollout_reducer.messages().get(index) {
                    deltas.push(AgentTranscriptDelta::MessageUpserted {
                        index: u32::try_from(index).unwrap_or(u32::MAX),
                        message: message.clone(),
                    });
                }
            }
            if let Some(length) = projection.turns_truncated_to {
                deltas.push(AgentTranscriptDelta::TurnsTruncated {
                    length: u32::try_from(length).unwrap_or(u32::MAX),
                });
            }
            for index in projection.turn_indexes {
                if let Some(turn) = self.rollout_reducer.turns().get(index) {
                    deltas.push(AgentTranscriptDelta::TurnUpserted {
                        index: u32::try_from(index).unwrap_or(u32::MAX),
                        turn: turn.clone(),
                    });
                }
            }
        }
        CodexAdapterUpdate {
            handled,
            reset,
            deltas,
        }
    }

    fn info(&self) -> AgentTranscriptInfo {
        AgentTranscriptInfo {
            id: self.session_id.clone(),
            title: None,
            directory: self.directory.clone(),
            created_at_ms: None,
            updated_at_ms: None,
        }
    }

    fn projected_messages(&self) -> &[AgentTranscriptMessage] {
        if self.rollout_reducer.is_authoritative() {
            self.rollout_reducer.messages()
        } else {
            &self.messages
        }
    }

    fn projected_turns(&self) -> Option<&[AgentTranscriptTurn]> {
        self.rollout_reducer
            .is_authoritative()
            .then(|| self.rollout_reducer.turns())
    }

    #[cfg(test)]
    fn unsupported_counts(&self) -> (u64, u64, u64, u64) {
        self.rollout_reducer.unsupported_counts()
    }

    pub fn snapshot(
        &self,
        revision: u64,
        status: AgentTranscriptStatus,
        error: Option<String>,
    ) -> AgentTranscriptState {
        let messages = self.projected_messages().to_vec();
        let turns = self
            .projected_turns()
            .map(<[AgentTranscriptTurn]>::to_vec)
            .unwrap_or_else(|| project_turns(&messages));
        AgentTranscriptState {
            session_id: self.session_id.clone(),
            agent: AgentTranscriptKind::Codex,
            revision,
            status,
            info: Some(self.info()),
            messages,
            turns,
            error,
        }
    }

    /*
     * Everything below this point is the deliberately retained legacy
     * response/EventMsg adapter. Current paginated history does not use its
     * text/proximity identity heuristics.
     */

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

    fn rollback_legacy(&mut self, num_turns: u32) {
        let turns = project_turns(&self.messages);
        let remove_count = usize::try_from(num_turns).unwrap_or(usize::MAX);
        let keep = turns.len().saturating_sub(remove_count);
        let removed_message_ids = turns[keep..]
            .iter()
            .flat_map(|turn| {
                turn.user_message_id
                    .iter()
                    .chain(&turn.assistant_message_ids)
            })
            .collect::<Vec<_>>();
        self.messages
            .retain(|message| !removed_message_ids.contains(&&message.id));
        self.message_indexes = self
            .messages
            .iter()
            .enumerate()
            .map(|(index, message)| (message.id.clone(), index))
            .collect();
        self.tools.clear();
        self.pending_tools.clear();
        self.process_tools.clear();
        self.recent_messages.clear();
        self.begin_turn();
    }

    fn user_message(&mut self, text: String, id: String, at: Option<u64>, explicit_id: bool) {
        let text = text.trim().to_owned();
        if text.is_empty() || injected_user_context(&text) {
            return;
        }
        let signature = format!("user\n{text}");
        if let Some((existing, sequence, existing_explicit_id)) =
            self.recent_messages.get_mut(&signature)
            && self.sequence.saturating_sub(*sequence) <= 4
            && (!explicit_id || !*existing_explicit_id)
        {
            *sequence = self.sequence;
            self.active_user_message_id = Some(existing.clone());
            return;
        }
        let message_id = format!("user:{id}");
        self.recent_messages
            .insert(signature, (message_id.clone(), self.sequence, explicit_id));
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

    fn assistant_text(
        &mut self,
        text: String,
        id: String,
        at: Option<u64>,
        reasoning: bool,
        explicit_id: bool,
    ) {
        let text = text.trim().to_owned();
        if text.is_empty() {
            return;
        }
        let signature = format!(
            "{}\n{text}",
            if reasoning { "reasoning" } else { "assistant" }
        );
        if let Some((_, sequence, existing_explicit_id)) = self.recent_messages.get_mut(&signature)
            && self.sequence.saturating_sub(*sequence) <= 4
            && (!explicit_id || !*existing_explicit_id)
        {
            *sequence = self.sequence;
            return;
        }
        let message_id = self.assistant_message_id(at);
        let part_id = format!("{}:{id}", if reasoning { "reasoning" } else { "text" });
        self.recent_messages
            .insert(signature, (part_id.clone(), self.sequence, explicit_id));
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

    #[allow(
        clippy::too_many_arguments,
        reason = "the reducer accepts the complete normalized tool event as distinct typed fields"
    )]
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
                diagnostics: Vec::new(),
                loaded: Vec::new(),
            },
            String::new(),
            at,
        ));
        let terminal = matches!(status, AgentToolStatus::Completed | AgentToolStatus::Error);
        let name = if name.is_empty() {
            if old_name.is_empty() {
                "tool".to_owned()
            } else {
                old_name
            }
        } else {
            name
        };
        let input = canonical_tool_input(&name, input.unwrap_or(old_state.input));
        let part = AgentTranscriptPart::Tool {
            id: key.clone(),
            call_id: id,
            tool: name,
            timestamp_ms: old_at,
            state: AgentToolState {
                status,
                input,
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
                diagnostics: old_state.diagnostics,
                loaded: old_state.loaded,
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
                self.user_message(text_content(item.get("content")), id, at, true);
            }
            "agent_message" => self.assistant_text(
                nonempty(item.get("text")).unwrap_or_default().to_owned(),
                id,
                at,
                false,
                true,
            ),
            "reasoning" => self.assistant_text(
                nonempty(item.get("text"))
                    .map(str::to_owned)
                    .unwrap_or_else(|| text_content(item.get("summary"))),
                id,
                at,
                true,
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
                    Some(fields([("command", command_title(item.get("command")))])),
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
        let has_item_id = nonempty(payload.get("id")).is_some();
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
                    Some("assistant") => {
                        self.assistant_text(content, item_id, at, false, has_item_id);
                    }
                    Some("user") => self.user_message(content, item_id, at, has_item_id),
                    _ => {}
                }
            }
            "reasoning" => self.assistant_text(
                text_content(payload.get("summary")),
                item_id,
                at,
                true,
                has_item_id,
            ),
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
            "function_call_output" | "custom_tool_call_output" | "tool_search_output" => {
                if let Some(pending) = self.pending_tools.remove(&call_id) {
                    let result = if kind == "tool_search_output" {
                        ParsedToolResult {
                            output: detail(payload.get("tools")),
                            error: (payload.get("status").and_then(Value::as_str)
                                == Some("failed"))
                            .then(|| "Tool search failed".to_owned()),
                            exit_code: None,
                            process_id: None,
                            running: false,
                        }
                    } else {
                        tool_result(payload.get("output"))
                    };
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

    fn accept_tool_event(
        &mut self,
        kind: &str,
        call_id: &str,
        payload: &Map<String, Value>,
        at: Option<u64>,
    ) -> bool {
        match kind {
            "exec_command_begin" => self.tool(
                call_id.to_owned(),
                "shell".to_owned(),
                AgentToolStatus::Running,
                Some(fields_with_cwd(payload)),
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
                    call_id.to_owned(),
                    "shell".to_owned(),
                    parse_tool_status(
                        payload.get("status"),
                        if exit == Some(0) {
                            AgentToolStatus::Completed
                        } else {
                            AgentToolStatus::Error
                        },
                    ),
                    Some(fields_with_cwd(payload)),
                    output,
                    exit.filter(|code| *code != 0)
                        .map(|code| format!("Exited with code {code}")),
                    exit,
                    Vec::new(),
                    at,
                );
            }
            "patch_apply_begin" | "patch_apply_updated" => self.tool(
                call_id.to_owned(),
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
                    call_id.to_owned(),
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
                    call_id.to_owned(),
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
                    call_id.to_owned(),
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
            _ => return false,
        }
        true
    }

    fn accept_event(&mut self, payload: &Map<String, Value>, at: Option<u64>) {
        let kind = nonempty(payload.get("type")).unwrap_or_default();
        let call_id = nonempty(payload.get("call_id"))
            .map(str::to_owned)
            .unwrap_or_else(|| self.sequence.to_string());
        if self.accept_tool_event(kind, &call_id, payload, at) {
            return;
        }
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
                false,
            ),
            "agent_message" => self.assistant_text(
                nonempty(payload.get("message"))
                    .unwrap_or_default()
                    .to_owned(),
                format!("event:{call_id}"),
                at,
                false,
                false,
            ),
            "agent_reasoning" => self.assistant_text(
                nonempty(payload.get("text")).unwrap_or_default().to_owned(),
                format!("event:{call_id}"),
                at,
                true,
                false,
            ),
            "turn_diff" => {
                let files = unified_diff_files(nonempty(payload.get("unified_diff")));
                if !files.is_empty() {
                    let message_id = self.assistant_message_id(at);
                    if let Some(message) = self.message_mut(&message_id) {
                        message.diffs = files;
                    }
                }
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

#[derive(Clone, Debug, Default)]
struct CodexAdapterUpdate {
    handled: bool,
    reset: bool,
    deltas: Vec<AgentTranscriptDelta>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
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
    #[serde(default)]
    revision: Option<u64>,
    #[serde(default)]
    transcript: Option<AgentTranscriptState>,
}

#[derive(Serialize)]
struct CachedCodexSessionRef<'a> {
    schema_version: u32,
    requested_session_id: &'a str,
    source: Option<&'a CodexSourceIdentity>,
    committed_offset: u64,
    lines: &'a [CachedCodexLine],
    revision: u64,
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
    pub update: Option<AgentTranscriptUpdate>,
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
        self.mark_stale_update(error);
        self.state()
    }

    pub fn mark_stale_update(&mut self, error: impl Into<String>) -> AgentTranscriptUpdate {
        self.status = if self.cached_lines.is_empty() {
            AgentTranscriptStatus::Error
        } else {
            AgentTranscriptStatus::Stale
        };
        self.error = Some(error.into());
        self.bump_revision();
        self.status_update()
    }

    pub fn mark_restarting_update(&mut self, reason: impl Into<String>) -> AgentTranscriptUpdate {
        if self.cached_lines.is_empty() {
            self.status = AgentTranscriptStatus::Loading;
            self.error = None;
        } else {
            self.status = AgentTranscriptStatus::Stale;
            self.error = Some(reason.into());
        }
        self.bump_revision();
        self.status_update()
    }

    pub fn mark_unavailable(&mut self, error: impl Into<String>) -> AgentTranscriptState {
        self.mark_unavailable_update(error);
        self.state()
    }

    pub fn mark_unavailable_update(&mut self, error: impl Into<String>) -> AgentTranscriptUpdate {
        self.status = if self.cached_lines.is_empty() {
            AgentTranscriptStatus::Unavailable
        } else {
            AgentTranscriptStatus::Stale
        };
        self.error = Some(error.into());
        self.bump_revision();
        self.status_update()
    }

    pub fn mark_live(&mut self) -> bool {
        if self.status != AgentTranscriptStatus::Live || self.error.is_some() {
            self.status = AgentTranscriptStatus::Live;
            self.error = None;
            self.bump_revision();
            true
        } else {
            false
        }
    }

    pub fn mark_live_update(&mut self) -> Option<AgentTranscriptUpdate> {
        self.mark_live().then(|| self.status_update())
    }

    pub fn close(&mut self) -> AgentTranscriptState {
        self.close_update();
        self.state()
    }

    pub fn close_update(&mut self) -> AgentTranscriptUpdate {
        self.source_generation = self.source_generation.saturating_add(1);
        self.status = AgentTranscriptStatus::Closed;
        self.error = None;
        self.bump_revision();
        self.status_update()
    }

    pub fn restore_cache(&mut self, bytes: &[u8]) -> Result<AgentTranscriptState, AgentCacheError> {
        let cached: CachedCodexSession = serde_json::from_slice(bytes)
            .map_err(|error| AgentCacheError::Malformed(error.to_string()))?;
        if !matches!(cached.schema_version, 1 | 2) {
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
        let revision = if cached.schema_version == 1 {
            let transcript = cached.transcript.as_ref().ok_or_else(|| {
                AgentCacheError::Malformed("legacy transcript is missing".to_owned())
            })?;
            let replay = adapter.snapshot(
                transcript.revision,
                transcript.status,
                transcript.error.clone(),
            );
            if replay.info != transcript.info
                || replay.messages != transcript.messages
                || replay.turns != transcript.turns
            {
                return Err(AgentCacheError::ReplayDiverged);
            }
            transcript.revision
        } else {
            if cached.transcript.is_some() {
                return Err(AgentCacheError::Malformed(
                    "schema 2 duplicated its transcript projection".to_owned(),
                ));
            }
            cached
                .revision
                .ok_or_else(|| AgentCacheError::Malformed("cache revision is missing".to_owned()))?
        };
        self.source = cached.source;
        self.committed_offset = cached.committed_offset;
        self.cached_lines = cached.lines;
        self.adapter = adapter;
        self.revision = revision;
        self.status = AgentTranscriptStatus::Stale;
        self.error = None;
        self.framer = TranscriptJsonlFramer::with_offset(self.committed_offset);
        self.bump_revision();
        Ok(self.state())
    }

    pub fn cache_blob(&self) -> Result<Vec<u8>, AgentCacheError> {
        let committable = self.framer.committable_offset();
        let committed_line_count = self
            .cached_lines
            .partition_point(|line| line.end_offset <= committable);
        serde_json::to_vec(&CachedCodexSessionRef {
            schema_version: 2,
            requested_session_id: &self.requested_session_id,
            source: self.source.as_ref(),
            committed_offset: committable,
            lines: &self.cached_lines[..committed_line_count],
            revision: self.revision,
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
                update: None,
            });
        }
        let lines = self.framer.push(bytes)?;
        let mut changed = false;
        let mut reset = false;
        let mut deltas = Vec::new();
        let mut malformed_records = 0;
        for line in lines {
            self.cached_lines.push(CachedCodexLine {
                raw_line: line.raw_line,
                end_offset: line.end_offset,
            });
            match line.parsed {
                Ok(Value::Null) => {}
                Ok(value) => {
                    let accepted = self.adapter.accept_incremental(&value);
                    changed |= accepted.handled;
                    reset |= accepted.reset;
                    deltas.extend(accepted.deltas);
                }
                Err(_) => malformed_records += 1,
            }
        }
        if changed {
            let status_changed = self.status != AgentTranscriptStatus::Live || self.error.is_some();
            self.status = AgentTranscriptStatus::Live;
            self.error = None;
            self.bump_revision();
            if reset {
                deltas = vec![AgentTranscriptDelta::Reset {
                    state: self.state(),
                }];
            } else if status_changed {
                deltas.push(AgentTranscriptDelta::StatusChanged {
                    status: self.status,
                    error: None,
                });
            }
        }
        let update = changed.then_some(AgentTranscriptUpdate {
            revision: self.revision,
            deltas,
        });
        Ok(CodexIngestResult {
            source_generation,
            received_offset: self.framer.received_offset(),
            committable_offset: self.framer.committable_offset(),
            malformed_records,
            changed,
            update,
        })
    }

    fn status_update(&self) -> AgentTranscriptUpdate {
        AgentTranscriptUpdate {
            revision: self.revision,
            deltas: vec![AgentTranscriptDelta::StatusChanged {
                status: self.status,
                error: self.error.clone(),
            }],
        }
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

    fn paginated_fixture() -> &'static [u8] {
        include_bytes!("../../test-fixtures/codex/paginated-rollout.jsonl")
    }

    fn parse_codex_chunks(bytes: &[u8], chunk_size: usize) -> AgentTranscriptState {
        let mut core = CodexSessionCore::new("requested");
        let binding = core.bind_source("/rollout".into(), "1:2".into(), bytes.len() as u64);
        for chunk in bytes.chunks(chunk_size) {
            core.ingest(binding.source_generation, chunk).unwrap();
        }
        core.state()
    }

    fn tool_parts(state: &AgentTranscriptState) -> Vec<(&str, &str, &AgentToolState)> {
        state
            .messages
            .iter()
            .flat_map(|message| &message.parts)
            .filter_map(|part| match part {
                AgentTranscriptPart::Tool {
                    call_id,
                    tool,
                    state,
                    ..
                } => Some((call_id.as_str(), tool.as_str(), state)),
                _ => None,
            })
            .collect()
    }

    fn text_parts_in_message(message: &AgentTranscriptMessage) -> String {
        message
            .parts
            .iter()
            .filter_map(|part| match part {
                AgentTranscriptPart::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
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
    fn legacy_response_messages_with_distinct_ids_are_not_deduplicated_by_text() {
        let mut adapter = CodexTranscriptAdapter::new("thread");
        for value in [
            serde_json::json!({"type":"response_item","payload":{"type":"message","id":"user-1","role":"user","content":[{"type":"input_text","text":"continue"}]}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","id":"agent-1","role":"assistant","content":[{"type":"output_text","text":"First answer"}]}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","id":"user-2","role":"user","content":[{"type":"input_text","text":"continue"}]}}),
        ] {
            adapter.accept(&value);
        }
        let state = adapter.snapshot(1, AgentTranscriptStatus::Live, None);
        assert_eq!(
            text_parts(&state, AgentMessageRole::User),
            ["continue", "continue"]
        );
        assert_eq!(state.turns.len(), 2);
    }

    #[test]
    fn legacy_thread_rollback_removes_the_requested_user_turns() {
        let mut adapter = CodexTranscriptAdapter::new("thread");
        for (turn, message) in [("turn-1", "one"), ("turn-2", "two")] {
            adapter.accept(&serde_json::json!({
                "type":"event_msg","payload":{"type":"task_started","turn_id":turn,"model_context_window":null}
            }));
            adapter.accept(&serde_json::json!({
                "type":"event_msg","payload":{"type":"user_message","message":message}
            }));
            adapter.accept(&serde_json::json!({
                "type":"event_msg","payload":{"type":"task_complete","turn_id":turn,"last_agent_message":null}
            }));
        }
        adapter.accept(&serde_json::json!({
            "type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}
        }));
        let state = adapter.snapshot(1, AgentTranscriptStatus::Live, None);
        assert_eq!(text_parts(&state, AgentMessageRole::User), ["one"]);
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
    fn current_paginated_rollout_projects_typed_items_and_canonical_turns() {
        let state = parse_codex_chunks(paginated_fixture(), paginated_fixture().len());
        assert_eq!(state.session_id, "thread-current");
        assert_eq!(
            state.info.as_ref().unwrap().directory.as_deref(),
            Some("/workspace/whip")
        );
        assert_eq!(
            state
                .turns
                .iter()
                .map(|turn| (turn.id.as_str(), turn.status))
                .collect::<Vec<_>>(),
            [
                ("turn-current-1", AgentTurnStatus::Idle),
                ("turn-current-2", AgentTurnStatus::Idle),
                ("turn-current-3", AgentTurnStatus::Interrupted),
            ]
        );
        assert_eq!(
            state.turns[0].user_message_id.as_deref(),
            Some("user-current-1")
        );
        assert_eq!(state.turns[0].started_at_ms, Some(1_787_745_601_000));
        assert_eq!(state.turns[0].completed_at_ms, Some(1_787_745_614_000));

        let users = state
            .messages
            .iter()
            .filter(|message| message.role == AgentMessageRole::User)
            .map(|message| (message.id.as_str(), text_parts_in_message(message)))
            .collect::<Vec<_>>();
        assert_eq!(
            users,
            [
                ("user-current-1", "Build it".to_owned()),
                ("user-continue-1", "continue".to_owned()),
                ("user-continue-2", "continue".to_owned()),
            ]
        );

        let assistant_parts = state
            .messages
            .iter()
            .filter(|message| message.role == AgentMessageRole::Assistant)
            .flat_map(|message| &message.parts)
            .collect::<Vec<_>>();
        assert!(assistant_parts.iter().any(|part| matches!(
            part,
            AgentTranscriptPart::Text { id, text, .. }
                if id == "agent-commentary-1" && text == "I am checking the protocol."
        )));
        assert!(!assistant_parts.iter().any(|part| matches!(
            part,
            AgentTranscriptPart::Reasoning { id, .. } if id == "agent-commentary-1"
        )));
        assert!(assistant_parts.iter().any(|part| matches!(
            part,
            AgentTranscriptPart::Reasoning { id, text, .. }
                if id == "reasoning-1" && text == "Inspected the persisted wire format."
        )));
        assert!(assistant_parts.iter().any(|part| matches!(
            part,
            AgentTranscriptPart::Plan { id, text, .. }
                if id == "plan-1" && text.contains("Decode records")
        )));
        assert!(assistant_parts.iter().any(|part| matches!(
            part,
            AgentTranscriptPart::Notice { id, text, .. }
                if id == "compaction-1" && text == "Context compacted"
        )));

        let tools = tool_parts(&state);
        let success = tools
            .iter()
            .find(|(call_id, _, _)| *call_id == "command-success")
            .unwrap();
        assert_eq!(success.1, "shell");
        assert_eq!(success.2.status, AgentToolStatus::Completed);
        assert_eq!(success.2.exit_code, Some(0));
        assert_eq!(success.2.output.as_deref(), Some("all tests passed\n"));
        assert!(success.2.input.iter().any(|field| {
            field.key == "process_id"
                && field.value
                    == (AgentScalarValue::String {
                        value: "4242".to_owned(),
                    })
        }));
        let failure = tools
            .iter()
            .find(|(call_id, _, _)| *call_id == "command-failure")
            .unwrap();
        assert_eq!(failure.2.status, AgentToolStatus::Error);
        assert_eq!(failure.2.exit_code, Some(101));
        assert_eq!(failure.2.error.as_deref(), Some("Exited with code 101"));
        assert!(tools.iter().any(|(id, tool, state)| {
            *id == "mcp-call-1"
                && *tool == "docs · lookup"
                && state.status == AgentToolStatus::Completed
        }));
        assert!(tools.iter().any(|(id, tool, state)| {
            *id == "dynamic-call-1"
                && *tool == "workspace · inspect"
                && state.output.as_deref() == Some("inspection complete")
        }));
        assert!(
            tools
                .iter()
                .any(|(id, tool, _)| { *id == "web-search-1" && *tool == "websearch" })
        );
        assert!(
            tools.iter().any(|(id, tool, _)| {
                *id == "image-generation-1" && *tool == "image_generation"
            })
        );
        let patch = tools
            .iter()
            .find(|(id, _, _)| *id == "file-change-1")
            .unwrap();
        assert_eq!(patch.2.files.len(), 3);
        let updated = patch
            .2
            .files
            .iter()
            .find(|diff| diff.file == "src/lib.rs")
            .unwrap();
        assert_eq!((updated.additions, updated.deletions), (1, 1));
        assert_eq!(state.turns[0].diffs.len(), 3);
    }

    #[test]
    fn current_paginated_full_and_chunked_parsing_are_equivalent() {
        let full = parse_codex_chunks(paginated_fixture(), paginated_fixture().len());
        for chunk_size in [1, 2, 7, 31, 257] {
            let mut chunked = parse_codex_chunks(paginated_fixture(), chunk_size);
            // Revisions count visible ingest batches, so transport chunking is
            // intentionally allowed to change only this monotonic counter.
            chunked.revision = full.revision;
            assert_eq!(chunked, full, "chunk size {chunk_size}");
        }
    }

    #[test]
    fn current_thread_rollback_removes_materialized_turns_and_messages() {
        let mut adapter = CodexTranscriptAdapter::new("thread");
        for index in 1..=3 {
            let turn_id = format!("turn-{index}");
            adapter.accept(&serde_json::json!({
                "type":"event_msg",
                "payload":{"type":"task_started","turn_id":turn_id,"model_context_window":null}
            }));
            adapter.accept(&serde_json::json!({
                "type":"event_msg",
                "payload":{
                    "type":"item_completed","thread_id":"thread","turn_id":turn_id,
                    "item":{"type":"UserMessage","id":format!("user-{index}"),"content":[{"type":"text","text":format!("message {index}")}]},
                    "completed_at_ms":index
                }
            }));
            adapter.accept(&serde_json::json!({
                "type":"event_msg",
                "payload":{"type":"task_complete","turn_id":turn_id,"last_agent_message":null}
            }));
        }
        adapter.accept(&serde_json::json!({
            "type":"event_msg",
            "payload":{"type":"thread_rolled_back","num_turns":2}
        }));
        let state = adapter.snapshot(1, AgentTranscriptStatus::Live, None);
        assert_eq!(
            state
                .turns
                .iter()
                .map(|turn| turn.id.as_str())
                .collect::<Vec<_>>(),
            ["turn-1"]
        );
        assert_eq!(text_parts(&state, AgentMessageRole::User), ["message 1"]);
    }

    #[test]
    fn unknown_current_records_are_counted_and_do_not_break_projection() {
        let mut adapter = CodexTranscriptAdapter::new("thread");
        adapter.accept(&serde_json::json!({"type":"future_rollout","payload":{}}));
        adapter.accept(&serde_json::json!({"type":"event_msg","payload":{"type":"future_event"}}));
        adapter.accept(&serde_json::json!({
            "type":"event_msg",
            "payload":{
                "type":"item_completed","thread_id":"thread","turn_id":"turn-1",
                "item":{"type":"FutureItem","id":"future-1"},"completed_at_ms":1
            }
        }));
        adapter.accept(
            &serde_json::json!({"type":"response_item","payload":{"type":"future_response"}}),
        );
        let state = adapter.snapshot(1, AgentTranscriptStatus::Live, None);
        assert_eq!(state.turns.len(), 1);
        assert!(state.messages.is_empty());
        assert_eq!(adapter.unsupported_counts(), (1, 1, 1, 1));
    }

    #[test]
    fn tool_search_output_completes_the_matching_legacy_tool() {
        let mut adapter = CodexTranscriptAdapter::new("thread");
        adapter.accept(&serde_json::json!({
            "type":"response_item",
            "payload":{"type":"tool_search_call","id":"search-item","call_id":"search-call","status":"in_progress","execution":"search_tools","arguments":{"query":"calendar"}}
        }));
        adapter.accept(&serde_json::json!({
            "type":"response_item",
            "payload":{"type":"tool_search_output","id":"search-output","call_id":"search-call","status":"completed","execution":"search_tools","tools":[{"name":"calendar.lookup"}]}
        }));
        let state = adapter.snapshot(1, AgentTranscriptStatus::Live, None);
        let tools = tool_parts(&state);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].0, "search-call");
        assert_eq!(tools[0].2.status, AgentToolStatus::Completed);
        assert!(
            tools[0]
                .2
                .output
                .as_deref()
                .unwrap()
                .contains("calendar.lookup")
        );
    }

    #[test]
    fn current_turn_completion_error_marks_the_canonical_turn_failed() {
        let mut adapter = CodexTranscriptAdapter::new("thread");
        adapter.accept(&serde_json::json!({
            "type":"event_msg",
            "payload":{"type":"task_started","turn_id":"turn-error","model_context_window":null}
        }));
        adapter.accept(&serde_json::json!({
            "type":"event_msg",
            "payload":{
                "type":"item_completed","thread_id":"thread","turn_id":"turn-error",
                "item":{"type":"AgentMessage","id":"error-message","content":[{"type":"Text","text":"Partial answer"}]},"completed_at_ms":2
            }
        }));
        adapter.accept(&serde_json::json!({
            "type":"event_msg",
            "payload":{"type":"task_complete","turn_id":"turn-error","last_agent_message":"Partial answer","error":{"message":"model failed"}}
        }));
        let state = adapter.snapshot(1, AgentTranscriptStatus::Live, None);
        assert_eq!(state.turns[0].id, "turn-error");
        assert_eq!(state.turns[0].status, AgentTurnStatus::Error);
        assert_eq!(state.messages[0].error.as_deref(), Some("model failed"));
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
                ..source
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
    fn codex_ingest_only_requests_projection_for_visible_current_changes() {
        let mut core = CodexSessionCore::new("thread");
        let binding = core.bind_source("/rollout".into(), "1:2".into(), 0);
        assert!(core.mark_live());

        let revision = core.revision();
        let ignored = core
            .ingest(binding.source_generation, b"{\"type\":\"unknown\"}\n")
            .unwrap();
        let should_emit = ignored.changed || core.mark_live();
        assert!(!should_emit);
        assert_eq!(core.revision(), revision);

        let changed = core
            .ingest(
                binding.source_generation,
                &record(
                    "event_msg",
                    serde_json::json!({"type":"user_message","message":"visible"}),
                ),
            )
            .unwrap();
        let should_emit = changed.changed || core.mark_live();
        assert!(should_emit);
        assert!(core.revision() > revision);
        assert_eq!(
            text_parts(&core.state(), AgentMessageRole::User),
            ["visible"]
        );

        let old_generation = binding.source_generation;
        core.bind_source("/rollout".into(), "1:2".into(), core.received_offset());
        let revision = core.revision();
        let stale = core.ingest(old_generation, b"ignored").unwrap();
        let current_generation = stale.source_generation == core.source_generation();
        let should_emit = stale.changed || (current_generation && core.mark_live());
        assert!(!should_emit);
        assert_eq!(core.revision(), revision);
        assert_eq!(core.state().status, AgentTranscriptStatus::Loading);
    }

    #[test]
    fn current_ingest_can_make_live_status_the_only_visible_change() {
        let mut core = CodexSessionCore::new("thread");
        let binding = core.bind_source("/rollout".into(), "1:2".into(), 0);
        let revision = core.revision();
        let ignored = core
            .ingest(binding.source_generation, b"{\"type\":\"unknown\"}\n")
            .unwrap();
        assert!(!ignored.changed);
        assert!(core.mark_live());
        assert_eq!(core.revision(), revision + 1);
        assert_eq!(core.state().status, AgentTranscriptStatus::Live);
    }

    #[test]
    fn paginated_codex_append_emits_only_the_touched_message_and_turn() {
        let lines = paginated_fixture()
            .split_inclusive(|byte| *byte == b'\n')
            .collect::<Vec<_>>();
        let mut core = CodexSessionCore::new("requested");
        let binding = core.bind_source("/rollout".into(), "1:2".into(), 0);
        let initial = lines[..3].concat();
        let reset = core.ingest(binding.source_generation, &initial).unwrap();
        assert!(matches!(
            reset.update.unwrap().deltas.as_slice(),
            [AgentTranscriptDelta::Reset { .. }]
        ));

        let appended = core.ingest(binding.source_generation, lines[3]).unwrap();
        let update = appended.update.expect("assistant item is visible");
        assert_eq!(update.deltas.len(), 2);
        assert!(matches!(
            &update.deltas[0],
            AgentTranscriptDelta::MessageUpserted { index: 1, message }
                if message.id == "assistant:turn-current-1" && message.parts.len() == 1
        ));
        assert!(matches!(
            &update.deltas[1],
            AgentTranscriptDelta::TurnUpserted { index: 0, turn }
                if turn.id == "turn-current-1"
        ));
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
    fn paginated_cache_replay_preserves_canonical_projection() {
        let fixture = paginated_fixture();
        let mut core = CodexSessionCore::new("requested");
        let binding = core.bind_source("/rollout".into(), "1:2".into(), fixture.len() as u64);
        core.ingest(binding.source_generation, fixture).unwrap();
        let expected = core.state();
        let cache = core.cache_blob().unwrap();

        let mut restored = CodexSessionCore::new("requested");
        let actual = restored.restore_cache(&cache).unwrap();
        assert_eq!(actual.messages, expected.messages);
        assert_eq!(actual.turns, expected.turns);
    }

    #[test]
    fn codex_cache_keeps_schema_and_serializes_only_the_complete_prefix() {
        let complete = record(
            "event_msg",
            serde_json::json!({"type":"user_message","message":"cached"}),
        );
        let malformed = b"not-json\n";
        let partial = b"{\"partial\":";
        let mut core = CodexSessionCore::new("thread");
        let binding = core.bind_source("/rollout".into(), "1:2".into(), 0);
        core.ingest(binding.source_generation, &complete).unwrap();
        core.ingest(binding.source_generation, malformed).unwrap();
        core.ingest(binding.source_generation, partial).unwrap();
        core.mark_live();

        let blob = core.cache_blob().unwrap();
        let cached: CachedCodexSession = serde_json::from_slice(&blob).unwrap();
        assert_eq!(cached.schema_version, 2);
        assert_eq!(cached.lines.len(), 1);
        assert_eq!(
            cached.lines[0].raw_line,
            std::str::from_utf8(&complete).unwrap().trim_end()
        );
        assert_eq!(cached.committed_offset, complete.len() as u64);
        assert_eq!(cached.revision, Some(core.revision()));
        assert!(cached.transcript.is_none());

        let legacy_blob = serde_json::to_vec(&CachedCodexSession {
            schema_version: 1,
            requested_session_id: core.requested_session_id.clone(),
            source: core.source.clone(),
            committed_offset: cached.committed_offset,
            lines: cached.lines,
            revision: None,
            transcript: Some(core.state()),
        })
        .unwrap();
        let mut restored = CodexSessionCore::new("thread");
        let restored_state = restored.restore_cache(&legacy_blob).unwrap();
        assert_eq!(restored_state.messages, core.state().messages);
        assert_eq!(restored_state.turns, core.state().turns);
    }

    #[test]
    fn incompatible_native_cache_versions_fail_safely() {
        let codex = CodexSessionCore::new("thread");
        let mut codex_blob: serde_json::Value =
            serde_json::from_slice(&codex.cache_blob().unwrap()).unwrap();
        codex_blob["schema_version"] = serde_json::json!(999);
        let mut restored_codex = CodexSessionCore::new("thread");
        assert!(matches!(
            restored_codex.restore_cache(&serde_json::to_vec(&codex_blob).unwrap()),
            Err(AgentCacheError::Malformed(_))
        ));

        let mut opencode = OpenCodeSessionCore::new("ses_cache");
        opencode.begin_sync_generation();
        opencode
            .bootstrap(
                0,
                &serde_json::json!({
                    "info": { "id": "ses_cache" },
                    "messages": []
                })
                .to_string(),
            )
            .unwrap();
        let mut opencode_blob: serde_json::Value =
            serde_json::from_slice(&opencode.cache_blob().unwrap()).unwrap();
        opencode_blob["schema_version"] = serde_json::json!(999);
        let mut restored_opencode = OpenCodeSessionCore::new("ses_cache");
        assert!(matches!(
            restored_opencode.restore_cache(&serde_json::to_vec(&opencode_blob).unwrap()),
            Err(AgentCacheError::Malformed(_))
        ));
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

    #[test]
    fn retry_without_cached_history_returns_to_loading() {
        let mut core = CodexSessionCore::new("thread");
        core.mark_unavailable("rollout not created");

        core.mark_restarting_update("Opening Codex transcript");

        let state = core.state();
        assert_eq!(state.status, AgentTranscriptStatus::Loading);
        assert_eq!(state.error, None);
    }
}
