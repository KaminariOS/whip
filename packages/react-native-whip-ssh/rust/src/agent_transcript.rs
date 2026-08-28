//! Agent-independent transcript domain model and Codex JSONL adapter.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::codex::rollout_wire::{Event as CodexEvent, ResponseItem as CodexResponseItem};
use crate::codex::{CodexRolloutReducer, RolloutRecord, decode_rollout_record};

pub const MAX_TRANSCRIPT_LINE_BYTES: usize = 4 * 1024 * 1024;
const OPENCODE_CACHE_SCHEMA_VERSION: u32 = 3;

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
pub enum AgentDiagnosticSeverity {
    Error,
    Warning,
    Info,
    Hint,
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

#[derive(Clone, Debug, PartialEq, Serialize, uniffi::Record)]
pub struct AgentFileDiff {
    pub file: String,
    pub patch: Option<String>,
    pub before: Option<String>,
    pub after: Option<String>,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Deserialize)]
struct UnnormalizedAgentFileDiff {
    file: String,
    patch: Option<String>,
    before: Option<String>,
    after: Option<String>,
    additions: Option<u32>,
    deletions: Option<u32>,
}

impl AgentFileDiff {
    pub(crate) fn normalized(
        file: String,
        patch: Option<String>,
        before: Option<String>,
        after: Option<String>,
        additions: Option<u32>,
        deletions: Option<u32>,
    ) -> Self {
        let (calculated_additions, calculated_deletions) = match patch.as_deref() {
            Some(patch) => diff_counts(patch),
            None => (
                after.as_deref().map(content_line_count).unwrap_or(0),
                before.as_deref().map(content_line_count).unwrap_or(0),
            ),
        };
        Self {
            file,
            patch,
            before,
            after,
            additions: additions.unwrap_or(calculated_additions),
            deletions: deletions.unwrap_or(calculated_deletions),
        }
    }
}

impl<'de> Deserialize<'de> for AgentFileDiff {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = UnnormalizedAgentFileDiff::deserialize(deserializer)?;
        Ok(Self::normalized(
            value.file,
            value.patch,
            value.before,
            value.after,
            value.additions,
            value.deletions,
        ))
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct AgentToolDiagnostic {
    pub file: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub message: String,
    pub severity: AgentDiagnosticSeverity,
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
    #[serde(default)]
    pub files: Vec<AgentFileDiff>,
    #[serde(default)]
    pub diagnostics: Vec<AgentToolDiagnostic>,
    #[serde(default)]
    pub loaded: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Enum)]
#[allow(
    clippy::large_enum_variant,
    reason = "UniFFI transcript variants cannot box their typed payload records"
)]
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

#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
#[allow(
    clippy::large_enum_variant,
    reason = "UniFFI delta variants cannot box the reset snapshot without changing the native API"
)]
pub enum AgentTranscriptDelta {
    Reset {
        state: AgentTranscriptState,
    },
    InfoChanged {
        info: Option<AgentTranscriptInfo>,
    },
    MessageUpserted {
        index: u32,
        message: AgentTranscriptMessage,
    },
    MessageRemoved {
        index: u32,
        message_id: String,
    },
    MessagesTruncated {
        length: u32,
    },
    TurnUpserted {
        index: u32,
        turn: AgentTranscriptTurn,
    },
    TurnsTruncated {
        length: u32,
    },
    StatusChanged {
        status: AgentTranscriptStatus,
        error: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct AgentTranscriptUpdate {
    pub revision: u64,
    pub deltas: Vec<AgentTranscriptDelta>,
}

impl AgentTranscriptUpdate {
    pub fn reset(state: AgentTranscriptState) -> Self {
        Self {
            revision: state.revision,
            deltas: vec![AgentTranscriptDelta::Reset { state }],
        }
    }
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

pub(crate) fn injected_user_context(value: &str) -> bool {
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

fn canonical_tool_input(tool: &str, mut fields: Vec<AgentField>) -> Vec<AgentField> {
    canonicalize_field(&mut fields, "command", &["command", "cmd"]);
    canonicalize_field(&mut fields, "path", &["path", "filePath", "file_path"]);
    canonicalize_field(&mut fields, "query", &["query", "pattern"]);
    canonicalize_field(&mut fields, "description", &["description", "name"]);
    canonicalize_field(&mut fields, "agent", &["agent", "subagent_type"]);
    canonicalize_field(&mut fields, "old_string", &["old_string", "oldString"]);
    canonicalize_field(&mut fields, "new_string", &["new_string", "newString"]);

    if tool == "shell" {
        canonicalize_field(&mut fields, "cwd", &["cwd", "workdir"]);
    }
    fields
}

fn tool_input(tool: &str, raw: Option<&Value>) -> Vec<AgentField> {
    let mut fields = scalar_fields(raw);
    if tool == "shell"
        && !fields
            .iter()
            .any(|field| field.key == "command" || field.key == "cmd")
        && let Some(command) =
            object(raw).and_then(|value| value.get("command").or_else(|| value.get("cmd")))
    {
        put_field(
            &mut fields,
            "command",
            AgentScalarValue::String {
                value: command_title(Some(command)),
            },
        );
    }
    canonical_tool_input(tool, fields)
}

fn canonicalize_field(fields: &mut Vec<AgentField>, canonical: &str, aliases: &[&str]) {
    let value = aliases.iter().find_map(|key| {
        fields
            .iter()
            .find(|field| field.key == *key)
            .map(|field| field.value.clone())
    });
    fields.retain(|field| !aliases.contains(&field.key.as_str()));
    if let Some(value) = value {
        put_field(fields, canonical, value);
    }
}

fn fields<const N: usize>(values: [(&str, String); N]) -> Vec<AgentField> {
    values
        .into_iter()
        .map(|(key, value)| AgentField {
            key: key.to_owned(),
            value: AgentScalarValue::String { value },
        })
        .collect()
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

fn fields_with_cwd(payload: &Map<String, Value>) -> Vec<AgentField> {
    let mut fields = fields([("command", command_title(payload.get("command")))]);
    if let Some(cwd) = nonempty(payload.get("cwd")) {
        put_field(
            &mut fields,
            "cwd",
            AgentScalarValue::String {
                value: cwd.to_owned(),
            },
        );
    }
    fields
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
        return (
            tool.clone(),
            tool_input(&tool, raw),
            None,
            false,
            Vec::new(),
        );
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
                fields([("query", query)]),
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

fn content_line_count(content: &str) -> u32 {
    u32::try_from(content.lines().count()).unwrap_or(u32::MAX)
}

fn legacy_change_files(value: Option<&Value>) -> Vec<AgentFileDiff> {
    object(value)
        .map(|changes| {
            changes
                .iter()
                .map(|(file, value)| {
                    let object = value.as_object();
                    let patch = object
                        .and_then(|value| {
                            nonempty(value.get("diff")).or_else(|| nonempty(value.get("patch")))
                        })
                        .map(str::to_owned)
                        .or_else(|| match value {
                            Value::Null | Value::Object(_) => None,
                            Value::String(value) if !value.is_empty() => Some(value.clone()),
                            value => detail(Some(value)),
                        });
                    AgentFileDiff::normalized(
                        file.clone(),
                        patch,
                        object
                            .and_then(|value| nonempty(value.get("before")))
                            .map(str::to_owned),
                        object
                            .and_then(|value| nonempty(value.get("after")))
                            .map(str::to_owned),
                        object
                            .and_then(|value| value.get("additions"))
                            .and_then(Value::as_u64)
                            .and_then(|value| value.try_into().ok()),
                        object
                            .and_then(|value| value.get("deletions"))
                            .and_then(Value::as_u64)
                            .and_then(|value| value.try_into().ok()),
                    )
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
        return vec![AgentFileDiff::normalized(
            file.to_owned(),
            Some(value.to_owned()),
            None,
            None,
            None,
            None,
        )];
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
            Some(AgentFileDiff::normalized(
                file,
                Some(patch),
                None,
                None,
                None,
                None,
            ))
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
                result.push(AgentFileDiff::normalized(
                    file,
                    Some(patch.trim_end().to_owned()),
                    None,
                    None,
                    None,
                    None,
                ));
            }
            current = Some((file.trim().to_owned(), String::new()));
        } else if let Some((_, patch)) = current.as_mut() {
            patch.push_str(line);
            patch.push('\n');
        }
    }
    if let Some((file, patch)) = current {
        result.push(AgentFileDiff::normalized(
            file,
            Some(patch.trim_end().to_owned()),
            None,
            None,
            None,
            None,
        ));
    }
    result
}

#[derive(Serialize)]
struct AgentTranscriptTurnRef<'a> {
    id: &'a str,
    user_message_id: Option<&'a str>,
    assistant_message_ids: Vec<&'a str>,
    status: AgentTurnStatus,
    started_at_ms: Option<u64>,
    completed_at_ms: Option<u64>,
    diffs: Vec<&'a AgentFileDiff>,
}

impl From<AgentTranscriptTurnRef<'_>> for AgentTranscriptTurn {
    fn from(turn: AgentTranscriptTurnRef<'_>) -> Self {
        Self {
            id: turn.id.to_owned(),
            user_message_id: turn.user_message_id.map(str::to_owned),
            assistant_message_ids: turn
                .assistant_message_ids
                .into_iter()
                .map(str::to_owned)
                .collect(),
            status: turn.status,
            started_at_ms: turn.started_at_ms,
            completed_at_ms: turn.completed_at_ms,
            diffs: turn.diffs.into_iter().cloned().collect(),
        }
    }
}

fn project_turn_refs(messages: &[AgentTranscriptMessage]) -> Vec<AgentTranscriptTurnRef<'_>> {
    let mut turns = Vec::<AgentTranscriptTurnRef<'_>>::new();
    let mut by_user = HashMap::<&str, usize>::new();
    let mut latest = None;
    for message in messages {
        if message.role == AgentMessageRole::User {
            let index = turns.len();
            turns.push(AgentTranscriptTurnRef {
                id: &message.id,
                user_message_id: Some(&message.id),
                assistant_message_ids: Vec::new(),
                status: AgentTurnStatus::Idle,
                started_at_ms: message.created_at_ms,
                completed_at_ms: message.completed_at_ms,
                diffs: message.diffs.iter().collect(),
            });
            by_user.insert(&message.id, index);
            latest = Some(index);
            continue;
        }
        let index = message
            .parent_id
            .as_ref()
            .and_then(|parent| by_user.get(parent.as_str()).copied())
            .or(latest)
            .unwrap_or_else(|| {
                let index = turns.len();
                turns.push(AgentTranscriptTurnRef {
                    id: message.parent_id.as_deref().unwrap_or(&message.id),
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
        turn.assistant_message_ids.push(&message.id);
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
                *current = diff;
            } else {
                turn.diffs.push(diff);
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

fn project_turns(messages: &[AgentTranscriptMessage]) -> Vec<AgentTranscriptTurn> {
    project_turn_refs(messages)
        .into_iter()
        .map(AgentTranscriptTurn::from)
        .collect()
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
    #[serde(default)]
    revision: Option<u64>,
    #[serde(default)]
    transcript: Option<AgentTranscriptState>,
}

#[derive(Serialize)]
struct AgentTranscriptInfoRef<'a> {
    id: &'a str,
    title: Option<&'a str>,
    directory: Option<&'a str>,
    created_at_ms: Option<u64>,
    updated_at_ms: Option<u64>,
}

impl<'a> From<&'a AgentTranscriptInfo> for AgentTranscriptInfoRef<'a> {
    fn from(info: &'a AgentTranscriptInfo) -> Self {
        Self {
            id: &info.id,
            title: info.title.as_deref(),
            directory: info.directory.as_deref(),
            created_at_ms: info.created_at_ms,
            updated_at_ms: info.updated_at_ms,
        }
    }
}

#[derive(Serialize)]
struct AgentTranscriptStateRef<'a> {
    session_id: &'a str,
    agent: AgentTranscriptKind,
    revision: u64,
    status: AgentTranscriptStatus,
    info: Option<AgentTranscriptInfoRef<'a>>,
    messages: &'a [AgentTranscriptMessage],
    turns: &'a [AgentTranscriptTurn],
    error: Option<&'a str>,
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

#[derive(Clone, Debug, Serialize, Deserialize)]
struct CachedOpenCodeSession {
    schema_version: u32,
    session_id: String,
    cursor: u64,
    transcript: AgentTranscriptState,
}

#[derive(Serialize)]
struct CachedOpenCodeSessionRef<'a> {
    schema_version: u32,
    session_id: &'a str,
    cursor: u64,
    transcript: AgentTranscriptStateRef<'a>,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum OpenCodeTranscriptError {
    #[error("OpenCode returned an invalid session export")]
    InvalidExport,
    #[error("OpenCode returned an invalid event cursor")]
    InvalidCursor,
    #[error("OpenCode returned invalid session events")]
    InvalidEvents,
    #[error("OpenCode part event references a missing message")]
    MissingMessage,
    #[error("OpenCode event database is behind the cached cursor")]
    CursorDiverged,
    #[error("OpenCode incremental events did not reach the remote cursor")]
    IncompleteEvents,
}

#[derive(Clone, Debug)]
enum OpenCodeMutation {
    Info(AgentTranscriptInfo),
    Message(AgentTranscriptMessage),
    RemoveMessage(String),
    Part {
        message_id: String,
        part: AgentTranscriptPart,
    },
    RemovePart {
        message_id: String,
        part_id: String,
    },
}

/// Compares the metadata from `message.updated` that does not determine turn
/// structure. Message identity is matched by `message_indexes`, while parts
/// have their own mutations.
fn same_open_code_nonstructural_message_metadata(
    current: &AgentTranscriptMessage,
    incoming: &AgentTranscriptMessage,
) -> bool {
    current.created_at_ms == incoming.created_at_ms
        && current.completed_at_ms == incoming.completed_at_ms
        && current.error == incoming.error
        && current.diffs == incoming.diffs
}

/// OpenCode export/event adapter with an opaque, cursor-bearing cache. Remote
/// I/O stays in `AgentSessionManager`; this type is deterministic and testable.
#[derive(Clone, Debug)]
pub struct OpenCodeSessionCore {
    session_id: String,
    source_generation: u64,
    cursor: Option<u64>,
    committed_cursor: Option<u64>,
    revision: u64,
    info: Option<AgentTranscriptInfo>,
    messages: Vec<AgentTranscriptMessage>,
    message_indexes: HashMap<String, usize>,
    turns: Vec<AgentTranscriptTurn>,
    turn_indexes: HashMap<String, usize>,
    message_turns: HashMap<String, usize>,
    status: AgentTranscriptStatus,
    error: Option<String>,
}

impl OpenCodeSessionCore {
    pub fn new(session_id: impl Into<String>) -> Self {
        let session_id = session_id.into();
        Self {
            info: Some(AgentTranscriptInfo {
                id: session_id.clone(),
                title: None,
                directory: None,
                created_at_ms: None,
                updated_at_ms: None,
            }),
            session_id,
            source_generation: 0,
            cursor: None,
            committed_cursor: None,
            revision: 0,
            messages: Vec::new(),
            message_indexes: HashMap::new(),
            turns: Vec::new(),
            turn_indexes: HashMap::new(),
            message_turns: HashMap::new(),
            status: AgentTranscriptStatus::Loading,
            error: None,
        }
    }

    pub fn source_generation(&self) -> u64 {
        self.source_generation
    }

    pub fn begin_sync_generation(&mut self) -> u64 {
        self.source_generation = self.source_generation.saturating_add(1);
        self.source_generation
    }

    pub fn cursor(&self) -> Option<u64> {
        self.cursor
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn committed_cursor(&self) -> Option<u64> {
        self.committed_cursor
    }

    pub fn state(&self) -> AgentTranscriptState {
        AgentTranscriptState {
            session_id: self.session_id.clone(),
            agent: AgentTranscriptKind::OpenCode,
            revision: self.revision,
            status: self.status,
            info: self.info.clone(),
            messages: self.messages.clone(),
            turns: self.turns.clone(),
            error: self.error.clone(),
        }
    }

    pub fn mark_stale(&mut self, error: impl Into<String>) -> AgentTranscriptState {
        self.mark_stale_update(error);
        self.state()
    }

    pub fn mark_stale_update(&mut self, error: impl Into<String>) -> AgentTranscriptUpdate {
        self.status = if self.cursor.is_some() {
            AgentTranscriptStatus::Stale
        } else {
            AgentTranscriptStatus::Error
        };
        self.error = Some(error.into());
        self.bump_revision();
        self.status_update()
    }

    pub fn mark_unavailable(&mut self, error: impl Into<String>) -> AgentTranscriptState {
        self.mark_unavailable_update(error);
        self.state()
    }

    pub fn mark_unavailable_update(&mut self, error: impl Into<String>) -> AgentTranscriptUpdate {
        self.status = if self.cursor.is_some() {
            AgentTranscriptStatus::Stale
        } else {
            AgentTranscriptStatus::Unavailable
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

    pub fn finish_live_update(
        &mut self,
        update: Option<AgentTranscriptUpdate>,
    ) -> Option<AgentTranscriptUpdate> {
        if self.status == AgentTranscriptStatus::Live && self.error.is_none() {
            return update;
        }
        self.status = AgentTranscriptStatus::Live;
        self.error = None;
        if let Some(mut update) = update {
            update.deltas.push(AgentTranscriptDelta::StatusChanged {
                status: AgentTranscriptStatus::Live,
                error: None,
            });
            update.revision = self.revision;
            return Some(update);
        }
        self.bump_revision();
        Some(self.status_update())
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
        let cached: CachedOpenCodeSession = serde_json::from_slice(bytes)
            .map_err(|error| AgentCacheError::Malformed(error.to_string()))?;
        if cached.schema_version != OPENCODE_CACHE_SCHEMA_VERSION {
            return Err(AgentCacheError::Malformed("unsupported schema".to_owned()));
        }
        if cached.session_id != self.session_id
            || cached.transcript.session_id != self.session_id
            || cached.transcript.agent != AgentTranscriptKind::OpenCode
        {
            return Err(AgentCacheError::SessionMismatch);
        }
        if cached.transcript.turns != project_turns(&cached.transcript.messages) {
            return Err(AgentCacheError::ReplayDiverged);
        }
        if cached
            .transcript
            .info
            .as_ref()
            .is_some_and(|info| info.id != self.session_id)
        {
            return Err(AgentCacheError::SessionMismatch);
        }
        self.cursor = Some(cached.cursor);
        self.committed_cursor = Some(cached.cursor);
        self.info = cached.transcript.info;
        self.messages = cached.transcript.messages;
        self.turns = cached.transcript.turns;
        self.rebuild_indexes();
        self.revision = cached.transcript.revision;
        self.status = AgentTranscriptStatus::Stale;
        self.error = None;
        self.bump_revision();
        Ok(self.state())
    }

    pub fn cache_blob(&self) -> Result<Vec<u8>, AgentCacheError> {
        let cursor = self.cursor.ok_or_else(|| {
            AgentCacheError::Malformed("OpenCode cursor is unavailable".to_owned())
        })?;
        serde_json::to_vec(&CachedOpenCodeSessionRef {
            schema_version: OPENCODE_CACHE_SCHEMA_VERSION,
            session_id: &self.session_id,
            cursor,
            transcript: AgentTranscriptStateRef {
                session_id: &self.session_id,
                agent: AgentTranscriptKind::OpenCode,
                revision: self.revision,
                status: self.status,
                info: self.info.as_ref().map(AgentTranscriptInfoRef::from),
                messages: &self.messages,
                turns: &self.turns,
                error: self.error.as_deref(),
            },
        })
        .map_err(|error| AgentCacheError::Malformed(error.to_string()))
    }

    pub fn confirm_cache(&mut self, source_generation: u64, cursor: u64) -> bool {
        if source_generation != self.source_generation
            || self.cursor.is_none_or(|current| cursor > current)
            || self
                .committed_cursor
                .is_some_and(|committed| cursor < committed)
        {
            return false;
        }
        self.committed_cursor = Some(cursor);
        true
    }

    /// Installs an authoritative export at the cursor read immediately before
    /// it. Events committed during the export are intentionally replayed by the
    /// next incremental query.
    pub fn bootstrap(
        &mut self,
        cursor: u64,
        export_json: &str,
    ) -> Result<bool, OpenCodeTranscriptError> {
        let value: Value = serde_json::from_str(export_json)
            .map_err(|_| OpenCodeTranscriptError::InvalidExport)?;
        let (info, messages) = parse_open_code_export(&value, &self.session_id)?;
        let changed = self.info.as_ref() != Some(&info) || self.messages != messages;
        self.cursor = Some(cursor);
        self.info = Some(info);
        self.messages = messages;
        self.turns = project_turns(&self.messages);
        self.rebuild_indexes();
        if changed {
            self.bump_revision();
        }
        Ok(changed)
    }

    pub fn bootstrap_update(
        &mut self,
        cursor: u64,
        export_json: &str,
    ) -> Result<Option<AgentTranscriptUpdate>, OpenCodeTranscriptError> {
        let changed = self.bootstrap(cursor, export_json)?;
        Ok(changed.then(|| AgentTranscriptUpdate::reset(self.state())))
    }

    pub fn apply_events(
        &mut self,
        remote_cursor: u64,
        events_json: &str,
    ) -> Result<bool, OpenCodeTranscriptError> {
        Ok(self
            .apply_events_incremental(remote_cursor, events_json)?
            .is_some())
    }

    pub fn apply_events_incremental(
        &mut self,
        remote_cursor: u64,
        events_json: &str,
    ) -> Result<Option<AgentTranscriptUpdate>, OpenCodeTranscriptError> {
        let local_cursor = self.cursor.ok_or(OpenCodeTranscriptError::InvalidCursor)?;
        if remote_cursor < local_cursor {
            return Err(OpenCodeTranscriptError::CursorDiverged);
        }
        let value: Value = serde_json::from_str(events_json)
            .map_err(|_| OpenCodeTranscriptError::InvalidEvents)?;
        let rows = value
            .as_array()
            .ok_or(OpenCodeTranscriptError::InvalidEvents)?;
        let mut cursor = local_cursor;
        let mut plan = Vec::new();
        let mut planned_messages = HashMap::<String, bool>::new();
        for row in rows {
            let row = row
                .as_object()
                .ok_or(OpenCodeTranscriptError::InvalidEvents)?;
            let sequence =
                open_code_u64(row.get("seq")).ok_or(OpenCodeTranscriptError::InvalidEvents)?;
            let raw_type =
                nonempty(row.get("type")).ok_or(OpenCodeTranscriptError::InvalidEvents)?;
            let event_type = strip_open_code_event_version(raw_type);
            let data = decoded_open_code_object(row.get("data"))
                .ok_or(OpenCodeTranscriptError::InvalidEvents)?;
            if sequence <= cursor {
                continue;
            }
            cursor = sequence;
            match event_type {
                "session.created" | "session.updated" => {
                    if let Some(next) = object(data.get("info"))
                        && nonempty(next.get("id")) == Some(self.session_id.as_str())
                    {
                        let next = open_code_session_info(next);
                        plan.push(OpenCodeMutation::Info(next));
                    }
                }
                "message.updated" => {
                    let Some(next_info) = data.get("info") else {
                        continue;
                    };
                    let Some(next) = open_code_message_from_parts(next_info, &[]) else {
                        continue;
                    };
                    planned_messages.insert(next.id.clone(), true);
                    plan.push(OpenCodeMutation::Message(next));
                }
                "message.removed" => {
                    let Some(message_id) = nonempty(data.get("messageID")) else {
                        continue;
                    };
                    planned_messages.insert(message_id.to_owned(), false);
                    plan.push(OpenCodeMutation::RemoveMessage(message_id.to_owned()));
                }
                "message.part.updated" => {
                    let Some(raw_part) = object(data.get("part")) else {
                        continue;
                    };
                    let Some(message_id) = nonempty(raw_part.get("messageID")) else {
                        continue;
                    };
                    let Some(next) = open_code_part(raw_part) else {
                        continue;
                    };
                    let exists = planned_messages
                        .get(message_id)
                        .copied()
                        .unwrap_or_else(|| self.message_indexes.contains_key(message_id));
                    if !exists {
                        return Err(OpenCodeTranscriptError::MissingMessage);
                    }
                    plan.push(OpenCodeMutation::Part {
                        message_id: message_id.to_owned(),
                        part: next,
                    });
                }
                "message.part.removed" => {
                    let Some(message_id) = nonempty(data.get("messageID")) else {
                        continue;
                    };
                    let Some(part_id) = nonempty(data.get("partID")) else {
                        continue;
                    };
                    plan.push(OpenCodeMutation::RemovePart {
                        message_id: message_id.to_owned(),
                        part_id: part_id.to_owned(),
                    });
                }
                _ => {}
            }
        }
        if cursor < remote_cursor {
            return Err(OpenCodeTranscriptError::IncompleteEvents);
        }
        let deltas = self.apply_open_code_plan(plan);
        let changed = !deltas.is_empty();
        self.cursor = Some(cursor);
        if changed {
            self.bump_revision();
        }
        Ok(changed.then_some(AgentTranscriptUpdate {
            revision: self.revision,
            deltas,
        }))
    }

    fn apply_open_code_plan(&mut self, plan: Vec<OpenCodeMutation>) -> Vec<AgentTranscriptDelta> {
        let mut deltas = Vec::new();
        let mut affected_turns = Vec::new();
        let mut structural = false;
        for mutation in plan {
            match mutation {
                OpenCodeMutation::Info(info) => {
                    if self.info.as_ref() != Some(&info) {
                        self.info = Some(info.clone());
                        deltas.push(AgentTranscriptDelta::InfoChanged { info: Some(info) });
                    }
                }
                OpenCodeMutation::Message(message) => {
                    if let Some(index) = self.message_indexes.get(&message.id).copied() {
                        let current = &mut self.messages[index];
                        debug_assert_eq!(current.id, message.id);
                        let structural_changed =
                            current.role != message.role || current.parent_id != message.parent_id;
                        if !structural_changed
                            && same_open_code_nonstructural_message_metadata(current, &message)
                        {
                            continue;
                        }

                        structural |= structural_changed;
                        current.role = message.role;
                        current.parent_id = message.parent_id;
                        current.created_at_ms = message.created_at_ms;
                        current.completed_at_ms = message.completed_at_ms;
                        current.error = message.error;
                        current.diffs = message.diffs;
                        let message = current.clone();
                        if let Some(turn) = self.message_turns.get(&message.id).copied() {
                            affected_turns.push(turn);
                        }
                        deltas.push(AgentTranscriptDelta::MessageUpserted {
                            index: u32::try_from(index).unwrap_or(u32::MAX),
                            message,
                        });
                    } else {
                        let index = self.messages.len();
                        self.message_indexes.insert(message.id.clone(), index);
                        self.messages.push(message.clone());
                        self.append_message_turn(index, &mut affected_turns);
                        deltas.push(AgentTranscriptDelta::MessageUpserted {
                            index: u32::try_from(index).unwrap_or(u32::MAX),
                            message,
                        });
                    }
                }
                OpenCodeMutation::RemoveMessage(message_id) => {
                    if let Some(index) = self.message_indexes.get(&message_id).copied() {
                        self.messages.remove(index);
                        deltas.push(AgentTranscriptDelta::MessageRemoved {
                            index: u32::try_from(index).unwrap_or(u32::MAX),
                            message_id,
                        });
                        structural = true;
                        self.rebuild_message_indexes();
                    }
                }
                OpenCodeMutation::Part { message_id, part } => {
                    let Some(index) = self.message_indexes.get(&message_id).copied() else {
                        continue;
                    };
                    let message = &mut self.messages[index];
                    if let Some(part_index) = message
                        .parts
                        .iter()
                        .position(|current| current.id() == part.id())
                    {
                        if message.parts[part_index] == part {
                            continue;
                        }
                        message.parts[part_index] = part;
                    } else {
                        message.parts.push(part);
                    }
                    if let Some(turn) = self.message_turns.get(&message_id).copied() {
                        affected_turns.push(turn);
                    }
                    deltas.push(AgentTranscriptDelta::MessageUpserted {
                        index: u32::try_from(index).unwrap_or(u32::MAX),
                        message: message.clone(),
                    });
                }
                OpenCodeMutation::RemovePart {
                    message_id,
                    part_id,
                } => {
                    let Some(index) = self.message_indexes.get(&message_id).copied() else {
                        continue;
                    };
                    let message = &mut self.messages[index];
                    let before = message.parts.len();
                    message.parts.retain(|part| part.id() != part_id);
                    if message.parts.len() == before {
                        continue;
                    }
                    if let Some(turn) = self.message_turns.get(&message_id).copied() {
                        affected_turns.push(turn);
                    }
                    deltas.push(AgentTranscriptDelta::MessageUpserted {
                        index: u32::try_from(index).unwrap_or(u32::MAX),
                        message: message.clone(),
                    });
                }
            }
        }
        if structural {
            self.rebuild_turns_with_deltas(&mut deltas);
        } else {
            affected_turns.sort_unstable();
            affected_turns.dedup();
            for index in affected_turns {
                self.recompute_turn(index);
                if let Some(turn) = self.turns.get(index) {
                    deltas.push(AgentTranscriptDelta::TurnUpserted {
                        index: u32::try_from(index).unwrap_or(u32::MAX),
                        turn: turn.clone(),
                    });
                }
            }
        }
        deltas
    }

    fn append_message_turn(&mut self, message_index: usize, affected_turns: &mut Vec<usize>) {
        let message = &self.messages[message_index];
        let turn_index = if message.role == AgentMessageRole::User {
            let index = self.turns.len();
            self.turns.push(AgentTranscriptTurn {
                id: message.id.clone(),
                user_message_id: Some(message.id.clone()),
                assistant_message_ids: Vec::new(),
                status: AgentTurnStatus::Idle,
                started_at_ms: message.created_at_ms,
                completed_at_ms: message.completed_at_ms,
                diffs: message.diffs.clone(),
            });
            self.turn_indexes.insert(message.id.clone(), index);
            index
        } else if let Some(index) = message
            .parent_id
            .as_ref()
            .and_then(|parent| self.turn_indexes.get(parent).copied())
            .or_else(|| self.turns.len().checked_sub(1))
        {
            self.turns[index]
                .assistant_message_ids
                .push(message.id.clone());
            index
        } else {
            let index = self.turns.len();
            let id = message
                .parent_id
                .clone()
                .unwrap_or_else(|| message.id.clone());
            self.turns.push(AgentTranscriptTurn {
                id: id.clone(),
                user_message_id: None,
                assistant_message_ids: vec![message.id.clone()],
                status: AgentTurnStatus::Idle,
                started_at_ms: message.created_at_ms,
                completed_at_ms: None,
                diffs: Vec::new(),
            });
            self.turn_indexes.insert(id, index);
            index
        };
        self.message_turns.insert(message.id.clone(), turn_index);
        affected_turns.push(turn_index);
    }

    fn recompute_turn(&mut self, index: usize) {
        let Some(turn) = self.turns.get_mut(index) else {
            return;
        };
        let user = turn
            .user_message_id
            .as_ref()
            .and_then(|id| self.message_indexes.get(id))
            .and_then(|index| self.messages.get(*index));
        turn.started_at_ms = user.and_then(|message| message.created_at_ms);
        turn.completed_at_ms = user.and_then(|message| message.completed_at_ms);
        turn.diffs = user
            .map(|message| message.diffs.clone())
            .unwrap_or_default();
        let mut running = false;
        let mut failed = false;
        for message_id in &turn.assistant_message_ids {
            let Some(message) = self
                .message_indexes
                .get(message_id)
                .and_then(|index| self.messages.get(*index))
            else {
                continue;
            };
            turn.started_at_ms = turn.started_at_ms.or(message.created_at_ms);
            if let Some(completed) = message.completed_at_ms {
                turn.completed_at_ms = Some(turn.completed_at_ms.unwrap_or(0).max(completed));
            }
            failed |= message.error.is_some();
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

    fn rebuild_message_indexes(&mut self) {
        self.message_indexes = self
            .messages
            .iter()
            .enumerate()
            .map(|(index, message)| (message.id.clone(), index))
            .collect();
    }

    fn rebuild_indexes(&mut self) {
        self.rebuild_message_indexes();
        self.turn_indexes = self
            .turns
            .iter()
            .enumerate()
            .map(|(index, turn)| (turn.id.clone(), index))
            .collect();
        self.message_turns.clear();
        for (index, turn) in self.turns.iter().enumerate() {
            if let Some(id) = &turn.user_message_id {
                self.message_turns.insert(id.clone(), index);
            }
            for id in &turn.assistant_message_ids {
                self.message_turns.insert(id.clone(), index);
            }
        }
    }

    fn rebuild_turns_with_deltas(&mut self, deltas: &mut Vec<AgentTranscriptDelta>) {
        let next = project_turns(&self.messages);
        let first_changed = self
            .turns
            .iter()
            .zip(&next)
            .position(|(current, next)| current != next)
            .unwrap_or(self.turns.len().min(next.len()));
        let previous_len = self.turns.len();
        self.turns = next;
        self.rebuild_indexes();
        if first_changed < previous_len {
            deltas.push(AgentTranscriptDelta::TurnsTruncated {
                length: u32::try_from(first_changed).unwrap_or(u32::MAX),
            });
        }
        for (index, turn) in self.turns.iter().enumerate().skip(first_changed) {
            deltas.push(AgentTranscriptDelta::TurnUpserted {
                index: u32::try_from(index).unwrap_or(u32::MAX),
                turn: turn.clone(),
            });
        }
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

pub fn parse_open_code_cursor(value: &str) -> Result<u64, OpenCodeTranscriptError> {
    let value: Value =
        serde_json::from_str(value).map_err(|_| OpenCodeTranscriptError::InvalidCursor)?;
    value
        .as_array()
        .and_then(|rows| rows.first())
        .and_then(Value::as_object)
        .and_then(|row| open_code_u64(row.get("seq")))
        .ok_or(OpenCodeTranscriptError::InvalidCursor)
}

fn parse_open_code_export(
    value: &Value,
    expected_session_id: &str,
) -> Result<(AgentTranscriptInfo, Vec<AgentTranscriptMessage>), OpenCodeTranscriptError> {
    let export = value
        .as_object()
        .ok_or(OpenCodeTranscriptError::InvalidExport)?;
    let info = object(export.get("info")).ok_or(OpenCodeTranscriptError::InvalidExport)?;
    if nonempty(info.get("id")) != Some(expected_session_id) {
        return Err(OpenCodeTranscriptError::InvalidExport);
    }
    let messages = export
        .get("messages")
        .and_then(Value::as_array)
        .ok_or(OpenCodeTranscriptError::InvalidExport)?
        .iter()
        .filter_map(|value| {
            let wrapper = value.as_object()?;
            let info = wrapper.get("info")?;
            let parts = wrapper
                .get("parts")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            open_code_message_from_parts(info, parts)
        })
        .collect();
    Ok((open_code_session_info(info), messages))
}

fn open_code_session_info(info: &Map<String, Value>) -> AgentTranscriptInfo {
    let time = object(info.get("time"));
    AgentTranscriptInfo {
        id: nonempty(info.get("id")).unwrap_or_default().to_owned(),
        title: nonempty(info.get("title")).map(str::to_owned),
        directory: nonempty(info.get("directory")).map(str::to_owned),
        created_at_ms: time.and_then(|time| timestamp_ms(time.get("created"))),
        updated_at_ms: time.and_then(|time| timestamp_ms(time.get("updated"))),
    }
}

fn open_code_message_from_parts(
    info: &Value,
    raw_parts: &[Value],
) -> Option<AgentTranscriptMessage> {
    let info = info.as_object()?;
    let id = nonempty(info.get("id"))?.to_owned();
    let role = match nonempty(info.get("role"))? {
        "user" => AgentMessageRole::User,
        "assistant" => AgentMessageRole::Assistant,
        _ => return None,
    };
    let time = object(info.get("time"));
    let summary = object(info.get("summary"));
    Some(AgentTranscriptMessage {
        id,
        role,
        parent_id: nonempty(info.get("parentID")).map(str::to_owned),
        created_at_ms: time.and_then(|time| timestamp_ms(time.get("created"))),
        completed_at_ms: time.and_then(|time| timestamp_ms(time.get("completed"))),
        error: info.get("error").and_then(|value| detail(Some(value))),
        parts: raw_parts
            .iter()
            .filter_map(Value::as_object)
            .filter_map(open_code_part)
            .collect(),
        diffs: summary
            .and_then(|summary| summary.get("diffs"))
            .map(open_code_diffs)
            .unwrap_or_default(),
    })
}

fn open_code_part(part: &Map<String, Value>) -> Option<AgentTranscriptPart> {
    if part.get("synthetic").and_then(Value::as_bool) == Some(true)
        || part.get("ignored").and_then(Value::as_bool) == Some(true)
    {
        return None;
    }
    let id = nonempty(part.get("id"))?.to_owned();
    let part_type = nonempty(part.get("type"))?;
    let time = object(part.get("time"));
    let at = time
        .and_then(|time| timestamp_ms(time.get("start")))
        .or_else(|| timestamp_ms(part.get("timestamp")));
    match part_type {
        "text" => Some(AgentTranscriptPart::Text {
            id,
            text: part
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            timestamp_ms: at,
        }),
        "reasoning" => Some(AgentTranscriptPart::Reasoning {
            id,
            text: part
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            timestamp_ms: at,
        }),
        "tool" => {
            let state = object(part.get("state"));
            let state_time = state.and_then(|state| object(state.get("time")));
            let tool = canonical_tool_name(nonempty(part.get("tool")).unwrap_or("tool"));
            if tool == "todowrite"
                && let Some(text) = open_code_todo_plan(state)
            {
                return Some(AgentTranscriptPart::Plan {
                    id,
                    text,
                    timestamp_ms: state_time
                        .and_then(|time| timestamp_ms(time.get("start")))
                        .or(at),
                });
            }
            let status = parse_tool_status(
                state.and_then(|state| state.get("status")),
                AgentToolStatus::Pending,
            );
            let metadata = state.and_then(|state| object(state.get("metadata")));
            let input = tool_input(&tool, state.and_then(|state| state.get("input")));
            Some(AgentTranscriptPart::Tool {
                call_id: nonempty(part.get("callID")).unwrap_or(&id).to_owned(),
                tool,
                timestamp_ms: state_time
                    .and_then(|time| timestamp_ms(time.get("start")))
                    .or(at),
                state: AgentToolState {
                    status,
                    input,
                    output: state.and_then(|state| detail(state.get("output"))),
                    error: state.and_then(|state| detail(state.get("error"))),
                    title: state
                        .and_then(|state| nonempty(state.get("title")))
                        .map(str::to_owned),
                    started_at_ms: state_time.and_then(|time| timestamp_ms(time.get("start"))),
                    completed_at_ms: state_time.and_then(|time| timestamp_ms(time.get("end"))),
                    exit_code: metadata
                        .and_then(|metadata| {
                            metadata
                                .get("exitCode")
                                .or_else(|| metadata.get("exit_code"))
                        })
                        .and_then(Value::as_i64),
                    files: open_code_tool_files(state),
                    diagnostics: open_code_tool_diagnostics(state),
                    loaded: metadata
                        .and_then(|metadata| metadata.get("loaded"))
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect(),
                },
                id,
            })
        }
        "subtask" => Some(AgentTranscriptPart::Plan {
            id,
            text: [
                nonempty(part.get("description")),
                nonempty(part.get("prompt")),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("\n\n"),
            timestamp_ms: at,
        }),
        _ => None,
    }
}

fn open_code_todo_plan(state: Option<&Map<String, Value>>) -> Option<String> {
    let todos = state
        .and_then(|state| object(state.get("input")))
        .and_then(|input| input.get("todos"))
        .and_then(Value::as_array)
        .or_else(|| {
            state
                .and_then(|state| object(state.get("metadata")))
                .and_then(|metadata| metadata.get("todos"))
                .and_then(Value::as_array)
        })?;
    let lines = todos
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|todo| {
            let content = nonempty(todo.get("content"))?;
            let completed = nonempty(todo.get("status")) == Some("completed");
            Some(format!(
                "- [{}] {content}",
                if completed { "x" } else { " " }
            ))
        })
        .collect::<Vec<_>>();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

fn open_code_diffs(value: &Value) -> Vec<AgentFileDiff> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter_map(|diff| {
            Some(AgentFileDiff::normalized(
                ["file", "relativePath", "filePath", "path"]
                    .into_iter()
                    .find_map(|key| nonempty(diff.get(key)))?
                    .to_owned(),
                ["patch", "diff", "unifiedDiff"]
                    .into_iter()
                    .find_map(|key| nonempty(diff.get(key)))
                    .map(str::to_owned),
                nonempty(diff.get("before")).map(str::to_owned),
                nonempty(diff.get("after")).map(str::to_owned),
                diff.get("additions")
                    .and_then(Value::as_u64)
                    .and_then(|value| value.try_into().ok()),
                diff.get("deletions")
                    .and_then(Value::as_u64)
                    .and_then(|value| value.try_into().ok()),
            ))
        })
        .collect()
}

fn open_code_tool_files(state: Option<&Map<String, Value>>) -> Vec<AgentFileDiff> {
    let Some(state) = state else {
        return Vec::new();
    };
    let metadata = object(state.get("metadata"));
    if let Some(files) = metadata.and_then(|metadata| metadata.get("files")) {
        let files = open_code_diffs(files);
        if !files.is_empty() {
            return files;
        }
    }
    if let Some(diff) = metadata.and_then(|metadata| {
        nonempty(metadata.get("unifiedDiff")).or_else(|| nonempty(metadata.get("unified_diff")))
    }) {
        return unified_diff_files(Some(diff));
    }
    if let Some(diff) = metadata.and_then(|metadata| {
        object(metadata.get("filediff")).or_else(|| object(metadata.get("fileDiff")))
    }) {
        let mut diff = diff.clone();
        if ["file", "relativePath", "filePath", "path"]
            .into_iter()
            .all(|key| nonempty(diff.get(key)).is_none())
        {
            diff.insert("file".to_owned(), Value::String("Changes".to_owned()));
        }
        let files = open_code_diffs(&Value::Array(vec![Value::Object(diff)]));
        if !files.is_empty() {
            return files;
        }
    }
    state
        .get("input")
        .and_then(Value::as_object)
        .map(|input| legacy_change_files(input.get("changes")))
        .unwrap_or_default()
}

fn open_code_tool_diagnostics(state: Option<&Map<String, Value>>) -> Vec<AgentToolDiagnostic> {
    let diagnostics = state
        .and_then(|state| {
            object(state.get("metadata"))
                .and_then(|metadata| metadata.get("diagnostics"))
                .or_else(|| state.get("diagnostics"))
        })
        .and_then(Value::as_object);
    let Some(diagnostics) = diagnostics else {
        return Vec::new();
    };
    diagnostics
        .iter()
        .flat_map(|(file, entries)| {
            entries
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|entry| open_code_diagnostic(file, entry))
        })
        .collect()
}

fn open_code_diagnostic(file: &str, value: &Value) -> Option<AgentToolDiagnostic> {
    let value = value.as_object()?;
    let start = object(value.get("range")).and_then(|range| object(range.get("start")));
    let one_based = |value: Option<&Value>| {
        value
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .map(|value| value.saturating_add(1))
    };
    let severity = match value.get("severity") {
        Some(Value::Number(value)) if value.as_u64() == Some(2) => AgentDiagnosticSeverity::Warning,
        Some(Value::Number(value)) if value.as_u64() == Some(3) => AgentDiagnosticSeverity::Info,
        Some(Value::Number(value)) if value.as_u64() == Some(4) => AgentDiagnosticSeverity::Hint,
        Some(Value::String(value)) if value.eq_ignore_ascii_case("warning") => {
            AgentDiagnosticSeverity::Warning
        }
        Some(Value::String(value)) if value.eq_ignore_ascii_case("info") => {
            AgentDiagnosticSeverity::Info
        }
        Some(Value::String(value)) if value.eq_ignore_ascii_case("hint") => {
            AgentDiagnosticSeverity::Hint
        }
        _ => AgentDiagnosticSeverity::Error,
    };
    Some(AgentToolDiagnostic {
        file: file.to_owned(),
        line: one_based(start.and_then(|start| start.get("line"))),
        column: one_based(start.and_then(|start| start.get("character"))),
        message: nonempty(value.get("message"))?.to_owned(),
        severity,
    })
}

fn decoded_open_code_object(value: Option<&Value>) -> Option<Map<String, Value>> {
    match value? {
        Value::Object(value) => Some(value.clone()),
        Value::String(value) => serde_json::from_str::<Value>(value)
            .ok()?
            .as_object()
            .cloned(),
        _ => None,
    }
}

fn strip_open_code_event_version(value: &str) -> &str {
    let Some((prefix, suffix)) = value.rsplit_once('.') else {
        return value;
    };
    if suffix.chars().all(|character| character.is_ascii_digit()) {
        prefix
    } else {
        value
    }
}

fn open_code_u64(value: Option<&Value>) -> Option<u64> {
    value?
        .as_u64()
        .or_else(|| value?.as_i64().and_then(|value| u64::try_from(value).ok()))
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
        include_bytes!("../test-fixtures/codex/paginated-rollout.jsonl")
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

    fn open_code_message_test_core() -> OpenCodeSessionCore {
        let export = serde_json::json!({
            "info": { "id": "ses_messages" },
            "messages": [
                {
                    "info": { "id": "user-1", "role": "user", "time": { "created": 1_u64 } },
                    "parts": [{ "id": "prompt-1", "type": "text", "text": "First" }]
                },
                {
                    "info": { "id": "user-2", "role": "user", "time": { "created": 3_u64 } },
                    "parts": [{ "id": "prompt-2", "type": "text", "text": "Second" }]
                },
                {
                    "info": {
                        "id": "assistant", "role": "assistant", "parentID": "user-1",
                        "time": { "created": 2_u64 }
                    },
                    "parts": [{ "id": "answer", "type": "text", "text": "Original" }]
                }
            ]
        });
        let mut core = OpenCodeSessionCore::new("ses_messages");
        core.bootstrap(0, &export.to_string()).unwrap();
        core
    }

    fn open_code_message_updated_event(sequence: u64, info: Value) -> String {
        serde_json::json!([{
            "seq": sequence,
            "type": "message.updated.1",
            "data": { "info": info }
        }])
        .to_string()
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
    fn file_diff_normalization_fills_counts_per_file() {
        let diffs = open_code_diffs(&serde_json::json!([
            {
                "file": "explicit.rs",
                "patch": "@@ -1 +1 @@\n-old\n+new\n",
                "additions": 2
            },
            {
                "file": "patch.rs",
                "patch": "@@ -0,0 +1,5 @@\n+one\n+two\n+three\n+four\n+five\n"
            }
        ]));

        assert_eq!(diffs.len(), 2);
        assert_eq!((diffs[0].additions, diffs[0].deletions), (2, 1));
        assert_eq!((diffs[1].additions, diffs[1].deletions), (5, 0));
        assert_eq!(diffs.iter().map(|diff| diff.additions).sum::<u32>(), 7);
    }

    #[test]
    fn deserialized_file_diffs_normalize_legacy_missing_counts() {
        let diff: AgentFileDiff = serde_json::from_value(serde_json::json!({
            "file": "cached.rs",
            "patch": "@@ -1 +1,2 @@\n-old\n+new\n+more\n",
            "additions": 9
        }))
        .unwrap();

        assert_eq!((diff.additions, diff.deletions), (9, 1));
    }

    #[test]
    fn open_code_tools_normalize_input_files_diagnostics_and_loaded_paths() {
        let value = serde_json::json!({
            "id": "tool-1",
            "type": "tool",
            "tool": "apply_patch",
            "state": {
                "status": "completed",
                "input": { "filePath": "src/main.rs" },
                "metadata": {
                    "files": [{
                        "relativePath": "src/main.rs",
                        "diff": "@@ -1 +1 @@\n-old\n+new\n"
                    }],
                    "diagnostics": {
                        "src/main.rs": [{
                            "severity": 1,
                            "message": "expected `;`",
                            "range": { "start": { "line": 4, "character": 8 } }
                        }]
                    },
                    "loaded": ["AGENTS.md"]
                }
            }
        });
        let AgentTranscriptPart::Tool { tool, state, .. } =
            open_code_part(value.as_object().unwrap()).unwrap()
        else {
            panic!("expected a tool part");
        };

        assert_eq!(tool, "patch");
        assert_eq!(state.input, fields([("path", "src/main.rs".to_owned())]));
        assert_eq!(state.files.len(), 1);
        assert_eq!(state.files[0].file, "src/main.rs");
        assert_eq!((state.files[0].additions, state.files[0].deletions), (1, 1));
        assert_eq!(
            state.diagnostics,
            [AgentToolDiagnostic {
                file: "src/main.rs".to_owned(),
                line: Some(5),
                column: Some(9),
                message: "expected `;`".to_owned(),
                severity: AgentDiagnosticSeverity::Error,
            }]
        );
        assert_eq!(state.loaded, ["AGENTS.md"]);
    }

    #[test]
    fn canonical_tool_input_collapses_wire_aliases() {
        let input = scalar_fields(Some(&serde_json::json!({
            "cmd": "cargo test",
            "workdir": "/repo",
            "file_path": "src/lib.rs",
            "pattern": "AgentToolState",
            "subagent_type": "reviewer"
        })));

        assert_eq!(
            canonical_tool_input("shell", input),
            [
                AgentField {
                    key: "command".to_owned(),
                    value: AgentScalarValue::String {
                        value: "cargo test".to_owned()
                    },
                },
                AgentField {
                    key: "path".to_owned(),
                    value: AgentScalarValue::String {
                        value: "src/lib.rs".to_owned()
                    },
                },
                AgentField {
                    key: "query".to_owned(),
                    value: AgentScalarValue::String {
                        value: "AgentToolState".to_owned()
                    },
                },
                AgentField {
                    key: "agent".to_owned(),
                    value: AgentScalarValue::String {
                        value: "reviewer".to_owned()
                    },
                },
                AgentField {
                    key: "cwd".to_owned(),
                    value: AgentScalarValue::String {
                        value: "/repo".to_owned()
                    },
                },
            ]
        );
        assert_eq!(
            tool_input(
                "shell",
                Some(&serde_json::json!({ "cmd": ["cargo", "test"] })),
            ),
            fields([("command", "cargo test".to_owned())])
        );
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
    fn opencode_export_and_events_are_projected_incrementally() {
        let export = serde_json::json!({
            "info": {
                "id": "ses_abc123", "title": "Fix chat view", "directory": "/repo",
                "time": { "created": 1_700_000_000_000_u64, "updated": 1_700_000_001_000_u64 }
            },
            "messages": [
                {
                    "info": { "id": "msg_user", "role": "user", "time": { "created": 1_u64 } },
                    "parts": [
                        { "id": "hidden", "type": "text", "text": "context", "synthetic": true },
                        { "id": "prompt", "type": "text", "text": "Fix it" }
                    ]
                },
                {
                    "info": { "id": "msg_assistant", "role": "assistant", "parentID": "msg_user", "time": { "created": 2_u64 } },
                    "parts": [
                        { "id": "reasoning", "type": "reasoning", "text": "Inspecting." },
                        { "id": "tool", "type": "tool", "callID": "call_1", "tool": "bash",
                          "state": { "status": "completed", "input": { "command": "npm test" }, "output": "ok" } }
                    ]
                }
            ]
        });
        let mut core = OpenCodeSessionCore::new("ses_abc123");
        core.begin_sync_generation();
        core.bootstrap(7, &export.to_string()).unwrap();
        assert!(core.mark_live());
        let state = core.state();
        assert_eq!(state.agent, AgentTranscriptKind::OpenCode);
        assert_eq!(
            state.info.as_ref().unwrap().directory.as_deref(),
            Some("/repo")
        );
        assert_eq!(text_parts(&state, AgentMessageRole::User), ["Fix it"]);
        assert_eq!(state.turns.len(), 1);

        let events = serde_json::json!([
            {
                "seq": 8_u64, "type": "message.part.updated.1",
                "data": serde_json::json!({
                    "part": { "id": "tool", "messageID": "msg_assistant", "type": "tool",
                              "callID": "call_1", "tool": "bash",
                              "state": { "status": "error", "input": { "command": "npm test" }, "error": "failed" } }
                }).to_string()
            },
            {
                "seq": 9_u64, "type": "message.part.removed.1",
                "data": { "messageID": "msg_assistant", "partID": "reasoning" }
            }
        ]);
        let update = core
            .apply_events_incremental(9, &events.to_string())
            .unwrap()
            .expect("tool update is visible");
        assert!(update.deltas.iter().all(|delta| match delta {
            AgentTranscriptDelta::MessageUpserted { message, .. } => {
                message.id == "msg_assistant"
            }
            AgentTranscriptDelta::TurnUpserted { turn, .. } => turn.id == "msg_user",
            _ => false,
        }));
        let state = core.state();
        assert_eq!(core.cursor(), Some(9));
        assert_eq!(state.turns[0].status, AgentTurnStatus::Error);
        assert!(
            !state.messages[1]
                .parts
                .iter()
                .any(|part| part.id() == "reasoning")
        );
    }

    #[test]
    fn opencode_identical_message_metadata_is_a_noop() {
        let mut core = open_code_message_test_core();
        let before = core.state();
        let revision = core.revision();
        let parts_ptr = core.messages[2].parts.as_ptr();
        let events = open_code_message_updated_event(
            1,
            serde_json::json!({
                "id": "assistant", "role": "assistant", "parentID": "user-1",
                "time": { "created": 2_u64 }
            }),
        );

        assert!(core.apply_events_incremental(1, &events).unwrap().is_none());
        assert_eq!(core.revision(), revision);
        assert_eq!(core.state(), before);
        assert_eq!(core.messages[2].parts.as_ptr(), parts_ptr);
    }

    #[test]
    fn opencode_message_metadata_update_preserves_existing_parts() {
        let mut core = open_code_message_test_core();
        let before = core.messages[2].clone();
        let parts_ptr = core.messages[2].parts.as_ptr();
        let events = open_code_message_updated_event(
            1,
            serde_json::json!({
                "id": "assistant", "role": "assistant", "parentID": "user-1",
                "time": { "created": 2_u64, "completed": 20_u64 }
            }),
        );

        let update = core
            .apply_events_incremental(1, &events)
            .unwrap()
            .expect("completion metadata changes the message");
        assert_eq!(update.deltas.len(), 2);
        assert!(matches!(
            &update.deltas[0],
            AgentTranscriptDelta::MessageUpserted { index: 2, message }
                if message.completed_at_ms == Some(20) && message.parts == before.parts
        ));
        assert!(matches!(
            &update.deltas[1],
            AgentTranscriptDelta::TurnUpserted { index: 0, turn }
                if turn.id == "user-1" && turn.completed_at_ms == Some(20)
        ));

        let current = &core.messages[2];
        assert_eq!(current.id, before.id);
        assert_eq!(current.role, before.role);
        assert_eq!(current.parent_id, before.parent_id);
        assert_eq!(current.created_at_ms, before.created_at_ms);
        assert_eq!(current.completed_at_ms, Some(20));
        assert_eq!(current.error, before.error);
        assert_eq!(current.diffs, before.diffs);
        assert_eq!(current.parts, before.parts);
        assert_eq!(current.parts.as_ptr(), parts_ptr);
    }

    #[test]
    fn opencode_parent_change_rebuilds_turns_and_indexes() {
        let mut core = open_code_message_test_core();
        let parts_ptr = core.messages[2].parts.as_ptr();
        let events = open_code_message_updated_event(
            1,
            serde_json::json!({
                "id": "assistant", "role": "assistant", "parentID": "user-2",
                "time": { "created": 2_u64 }
            }),
        );

        let update = core
            .apply_events_incremental(1, &events)
            .unwrap()
            .expect("parent metadata changes the turn structure");
        assert_eq!(update.deltas.len(), 4);
        assert!(matches!(
            &update.deltas[0],
            AgentTranscriptDelta::MessageUpserted { index: 2, message }
                if message.parent_id.as_deref() == Some("user-2")
        ));
        assert!(matches!(
            &update.deltas[1],
            AgentTranscriptDelta::TurnsTruncated { length: 0 }
        ));
        assert_eq!(core.turns[0].assistant_message_ids, Vec::<String>::new());
        assert_eq!(core.turns[1].assistant_message_ids, ["assistant"]);
        assert_eq!(core.message_indexes.get("assistant"), Some(&2));
        assert_eq!(core.message_turns.get("assistant"), Some(&1));
        assert_eq!(core.messages[2].parts.as_ptr(), parts_ptr);
    }

    #[test]
    fn opencode_part_update_still_replaces_the_matching_part() {
        let mut core = open_code_message_test_core();
        let events = serde_json::json!([{
            "seq": 1_u64,
            "type": "message.part.updated.1",
            "data": {
                "part": {
                    "id": "answer", "messageID": "assistant",
                    "type": "text", "text": "Updated"
                }
            }
        }]);

        let update = core
            .apply_events_incremental(1, &events.to_string())
            .unwrap()
            .expect("part text changes the message");
        assert_eq!(update.deltas.len(), 2);
        assert!(matches!(
            &update.deltas[0],
            AgentTranscriptDelta::MessageUpserted { index: 2, message }
                if message.parts.len() == 1
                    && matches!(&message.parts[0], AgentTranscriptPart::Text { id, text, .. }
                        if id == "answer" && text == "Updated")
        ));
        assert!(matches!(
            &update.deltas[1],
            AgentTranscriptDelta::TurnUpserted { index: 0, turn }
                if turn.id == "user-1"
        ));
        assert_eq!(core.messages[2].parts.len(), 1);
        assert!(matches!(
            &core.messages[2].parts[0],
            AgentTranscriptPart::Text { id, text, .. }
                if id == "answer" && text == "Updated"
        ));
    }

    #[test]
    fn opencode_todowrite_is_projected_as_a_task_plan() {
        let raw = serde_json::json!({
            "id": "todo-part",
            "type": "tool",
            "callID": "todo-call",
            "tool": "todowrite",
            "state": {
                "status": "completed",
                "input": {
                    "todos": [
                        { "content": "Inspect the parser", "status": "completed", "priority": "high" },
                        { "content": "Render the task list", "status": "in_progress", "priority": "high" },
                        { "content": "Run the tests", "status": "pending", "priority": "medium" }
                    ]
                },
                "time": { "start": 1_700_000_000_000_u64 }
            }
        });
        assert_eq!(
            open_code_part(raw.as_object().unwrap()),
            Some(AgentTranscriptPart::Plan {
                id: "todo-part".to_owned(),
                text: concat!(
                    "- [x] Inspect the parser\n",
                    "- [ ] Render the task list\n",
                    "- [ ] Run the tests"
                )
                .to_owned(),
                timestamp_ms: Some(1_700_000_000_000),
            })
        );

        let pending = serde_json::json!({
            "id": "todo-pending",
            "type": "tool",
            "callID": "todo-pending-call",
            "tool": "todowrite",
            "state": { "status": "pending", "input": {} }
        });
        assert!(matches!(
            open_code_part(pending.as_object().unwrap()),
            Some(AgentTranscriptPart::Tool { tool, .. }) if tool == "todowrite"
        ));
    }

    #[test]
    fn opencode_cache_restores_cursor_and_rejects_divergence() {
        let export = serde_json::json!({
            "info": { "id": "ses_cache" },
            "messages": [{
                "info": { "id": "user", "role": "user" },
                "parts": [{ "id": "text", "type": "text", "text": "cached" }]
            }]
        });
        let mut core = OpenCodeSessionCore::new("ses_cache");
        let generation = core.begin_sync_generation();
        core.bootstrap(4, &export.to_string()).unwrap();
        core.mark_live();
        let blob = core.cache_blob().unwrap();
        assert!(core.confirm_cache(generation, 4));
        let cached: Value = serde_json::from_slice(&blob).unwrap();
        assert_eq!(
            cached.get("schema_version").and_then(Value::as_u64),
            Some(u64::from(OPENCODE_CACHE_SCHEMA_VERSION))
        );

        let mut legacy = cached;
        legacy["schema_version"] = serde_json::json!(1);
        assert!(matches!(
            OpenCodeSessionCore::new("ses_cache")
                .restore_cache(&serde_json::to_vec(&legacy).unwrap()),
            Err(AgentCacheError::Malformed(_))
        ));

        let mut restored = OpenCodeSessionCore::new("ses_cache");
        let state = restored.restore_cache(&blob).unwrap();
        assert_eq!(state.status, AgentTranscriptStatus::Stale);
        assert_eq!(restored.cursor(), Some(4));
        assert_eq!(text_parts(&state, AgentMessageRole::User), ["cached"]);
        assert_eq!(
            restored.apply_events(3, "[]").unwrap_err(),
            OpenCodeTranscriptError::CursorDiverged
        );
    }

    #[test]
    fn opencode_small_event_on_one_thousand_messages_stays_small() {
        let messages = (0..1_000)
            .map(|index| {
                serde_json::json!({
                    "info": { "id": format!("message-{index}"), "role": "user" },
                    "parts": []
                })
            })
            .collect::<Vec<_>>();
        let export = serde_json::json!({
            "info": { "id": "ses_scale" },
            "messages": messages
        });
        let mut core = OpenCodeSessionCore::new("ses_scale");
        core.bootstrap(0, &export.to_string()).unwrap();
        let events = serde_json::json!([{
            "seq": 1_u64,
            "type": "message.part.updated.1",
            "data": {
                "part": {
                    "id": "part-999", "messageID": "message-999",
                    "type": "text", "text": "incremental"
                }
            }
        }]);

        let update = core
            .apply_events_incremental(1, &events.to_string())
            .unwrap()
            .expect("part update changes state");
        assert_eq!(update.deltas.len(), 2);
        assert!(matches!(
            &update.deltas[0],
            AgentTranscriptDelta::MessageUpserted { index: 999, message }
                if message.id == "message-999" && message.parts.len() == 1
        ));
        assert!(matches!(
            &update.deltas[1],
            AgentTranscriptDelta::TurnUpserted { index: 999, turn }
                if turn.id == "message-999"
        ));
        assert_eq!(core.messages.len(), 1_000);
        assert_eq!(core.turns.len(), 1_000);
    }

    #[test]
    fn opencode_invalid_batch_is_atomic_without_a_history_clone() {
        let export = serde_json::json!({
            "info": { "id": "ses_atomic" },
            "messages": [{
                "info": { "id": "message", "role": "assistant" },
                "parts": []
            }]
        });
        let mut core = OpenCodeSessionCore::new("ses_atomic");
        core.bootstrap(0, &export.to_string()).unwrap();
        let events = serde_json::json!([
            {
                "seq": 1_u64, "type": "message.part.updated.1",
                "data": { "part": {
                    "id": "would-apply", "messageID": "message",
                    "type": "text", "text": "partial mutation"
                }}
            },
            {
                "seq": 2_u64, "type": "message.part.updated.1",
                "data": { "part": {
                    "id": "invalid", "messageID": "missing",
                    "type": "text", "text": "invalid reference"
                }}
            }
        ]);

        assert_eq!(
            core.apply_events_incremental(2, &events.to_string())
                .unwrap_err(),
            OpenCodeTranscriptError::MissingMessage
        );
        assert_eq!(core.cursor(), Some(0));
        assert!(core.messages[0].parts.is_empty());
    }
}
