//! Agent launch, paste submission, and integration behavior.

use super::*;
use crate::agent_sessions::{AgentSessionError, AgentSessionOpenResult};
use crate::agent_transcript::{AgentTranscriptKind, AgentTranscriptState};
use crate::herdr_api::{
    HerdrAgentKind, HerdrControlError, HerdrControlRequest, HerdrControlResult,
    HerdrIntegrationInstallResult, HerdrTabLaunch, HerdrTabLaunchResult, HerdrTabLaunchStage,
};
use crate::remote_ops::shell_quote;

pub(super) fn managed_agent_name(label: &str, kind: HerdrAgentKind, tab_number: f64) -> String {
    let mut normalized = String::new();
    let mut previous_was_dash = false;
    for character in label.to_lowercase().chars() {
        if character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_' {
            normalized.push(character);
            previous_was_dash = false;
        } else if character == '-' {
            normalized.push(character);
            previous_was_dash = true;
        } else if !previous_was_dash {
            normalized.push('-');
            previous_was_dash = true;
        }
    }
    let first_letter = normalized
        .char_indices()
        .find_map(|(index, character)| character.is_ascii_lowercase().then_some(index));
    normalized = first_letter.map_or_else(String::new, |index| normalized[index..].to_owned());
    while normalized.ends_with('-') {
        normalized.pop();
    }
    if normalized.is_empty() {
        normalized = format!("{}-{tab_number}", kind.as_str());
    }
    normalized.truncate(normalized.len().min(32));
    normalized
}

pub(super) fn integration_status_command(herdr_command: &str) -> String {
    let herdr_command = herdr_command.trim();
    let herdr_command = if herdr_command.is_empty() {
        "herdr"
    } else {
        herdr_command
    };
    let command = format!("{} integration status", shell_quote(herdr_command));
    let bootstrap = r#"exec "${SHELL:-/bin/sh}" -lc "$1""#;
    format!(
        "exec /bin/sh -c {} whip {}",
        shell_quote(bootstrap),
        shell_quote(&command)
    )
}

pub(super) fn parse_agent_integration_status(
    output: &str,
    kind: HerdrAgentKind,
) -> AgentIntegrationStatus {
    let prefix = format!("{}:", kind.as_str());
    let Some(status) = output.lines().find_map(|line| {
        let line = line.trim().to_lowercase();
        line.strip_prefix(&prefix).map(str::trim).map(str::to_owned)
    }) else {
        return AgentIntegrationStatus::Unknown;
    };
    let matches = |expected: &str| {
        status == expected
            || status
                .strip_prefix(expected)
                .and_then(|suffix| suffix.chars().next())
                .is_some_and(|character| character.is_whitespace() || character == '(')
    };
    if matches("not installed") {
        AgentIntegrationStatus::NotInstalled
    } else if matches("current") {
        AgentIntegrationStatus::Current
    } else if matches("outdated") {
        AgentIntegrationStatus::Outdated
    } else if matches("needs repair") {
        AgentIntegrationStatus::NeedsRepair
    } else {
        AgentIntegrationStatus::Unknown
    }
}

pub(super) fn has_shell_command_semantics(command: &str) -> bool {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Quote {
        Single,
        Double,
    }

    let mut quote = None;
    for character in command.chars() {
        match quote {
            Some(Quote::Single) => {
                if character == '\'' {
                    quote = None;
                }
            }
            Some(Quote::Double) => match character {
                '"' => quote = None,
                '$' | '`' | '\n' | '\r' => return true,
                _ => {}
            },
            None => match character {
                '\'' => quote = Some(Quote::Single),
                '"' => quote = Some(Quote::Double),
                '\\' | '\n' | '\r' | '$' | '`' | '|' | '&' | ';' | '<' | '>' | '(' | ')' | '['
                | ']' | '{' | '}' | '*' | '?' | '!' | '#' | '~' => return true,
                _ => {}
            },
        }
    }
    false
}

pub(super) fn normalize_tab_launch(
    launch: HerdrTabLaunch,
) -> Result<HerdrTabLaunch, HerdrControlError> {
    let HerdrTabLaunch::Command { command } = launch else {
        return Ok(launch);
    };
    let command = command.trim().to_owned();
    if command.is_empty() {
        return Err(HerdrControlError::InvalidField(
            "command must not be empty".to_owned(),
        ));
    }
    if has_shell_command_semantics(&command) {
        return Ok(HerdrTabLaunch::Command { command });
    }
    let Some(mut args) = shlex::split(&command) else {
        return Ok(HerdrTabLaunch::Command { command });
    };
    let Some(executable) = args.first() else {
        return Ok(HerdrTabLaunch::Command { command });
    };
    let kind = match executable.as_str() {
        "claude" => HerdrAgentKind::Claude,
        "codex" => HerdrAgentKind::Codex,
        "opencode" => HerdrAgentKind::OpenCode,
        _ => return Ok(HerdrTabLaunch::Command { command }),
    };
    args.remove(0);
    Ok(HerdrTabLaunch::Agent { kind, args })
}

pub(super) fn launch_request(
    tab: &crate::herdr_api::HerdrTabInfo,
    root_pane: &crate::herdr_api::HerdrPaneInfo,
    launch: HerdrTabLaunch,
) -> Option<(HerdrTabLaunchStage, HerdrControlRequest)> {
    match launch {
        HerdrTabLaunch::Shell => None,
        HerdrTabLaunch::Agent { kind, args } => Some((
            HerdrTabLaunchStage::AgentStart,
            HerdrControlRequest::AgentStart {
                name: managed_agent_name(&tab.label, kind, tab.number),
                kind,
                pane_id: root_pane.pane_id.clone(),
                args,
            },
        )),
        HerdrTabLaunch::Command { command } => Some((
            HerdrTabLaunchStage::CommandInput,
            HerdrControlRequest::PaneSendInput {
                pane_id: root_pane.pane_id.clone(),
                text: command,
                keys: vec!["enter".to_owned()],
            },
        )),
    }
}

pub(super) async fn create_tab_with_launch_inner(
    inner: Arc<RuntimeInner>,
    workspace_id: String,
    label: String,
    launch: HerdrTabLaunch,
) -> Result<HerdrTabLaunchResult, HerdrControlError> {
    let launch = normalize_tab_launch(launch)?;
    let label = label.trim();
    let created = control_request_inner(
        inner.clone(),
        HerdrControlRequest::TabCreate {
            workspace_id,
            label: (!label.is_empty()).then(|| label.to_owned()),
        },
    )
    .await?;
    let HerdrControlResult::TabCreated { tab, root_pane } = created else {
        return Err(HerdrControlError::UnsupportedResponse(
            "tab.create returned a non-tab result".to_owned(),
        ));
    };
    let Some((stage, request)) = launch_request(&tab, &root_pane, launch) else {
        return Ok(HerdrTabLaunchResult::Created { tab, root_pane });
    };
    match control_request_inner(inner, request).await {
        Ok(_) => Ok(HerdrTabLaunchResult::Created { tab, root_pane }),
        Err(error) => Ok(HerdrTabLaunchResult::LaunchFailed {
            tab,
            root_pane,
            stage,
            failure: error.into(),
        }),
    }
}

pub(super) fn pane_submission_requests(
    pane_id: String,
    parts: Vec<String>,
) -> Vec<(HerdrControlRequest, bool)> {
    let parts = parts
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.is_empty() {
        return vec![(
            HerdrControlRequest::PaneSendKeys {
                pane_id,
                keys: vec!["enter".to_owned()],
            },
            false,
        )];
    }

    let part_count = parts.len();
    let mut requests = Vec::with_capacity(part_count.saturating_mul(2).saturating_sub(1));
    for (index, text) in parts.into_iter().enumerate() {
        if index > 0 {
            requests.push((
                HerdrControlRequest::PaneSendText {
                    pane_id: pane_id.clone(),
                    text: " ".to_owned(),
                },
                false,
            ));
        }
        requests.push((
            HerdrControlRequest::PaneSendInput {
                pane_id: pane_id.clone(),
                text,
                keys: if index + 1 == part_count {
                    vec!["enter".to_owned()]
                } else {
                    Vec::new()
                },
            },
            true,
        ));
    }
    requests
}

pub(super) async fn submit_pastes_inner(
    inner: Arc<RuntimeInner>,
    pane_id: String,
    parts: Vec<String>,
) -> Result<(), HostRuntimeError> {
    let mut submitted_parts = 0_u32;
    for (request, completes_part) in pane_submission_requests(pane_id, parts) {
        control_request_inner(inner.clone(), request)
            .await
            .map_err(|error| HostRuntimeError::PaneSubmissionFailure {
                submitted_parts,
                message: error.to_string(),
            })?;
        if completes_part {
            submitted_parts = submitted_parts.saturating_add(1);
        }
    }
    Ok(())
}
#[uniffi::export]
impl HostRuntime {
    pub fn open_agent_session(
        &self,
        agent: AgentTranscriptKind,
        terminal_id: String,
        session_id: String,
        cache_blob: Option<Vec<u8>>,
    ) -> Result<AgentSessionOpenResult, AgentSessionError> {
        match agent {
            AgentTranscriptKind::Codex => {
                let (key, state) =
                    self.inner
                        .agents
                        .open_codex(terminal_id, session_id, cache_blob)?;
                Ok(AgentSessionOpenResult {
                    runtime_incarnation: self.inner.incarnation,
                    key,
                    state,
                })
            }
            AgentTranscriptKind::OpenCode => {
                let (key, state) =
                    self.inner
                        .agents
                        .open_opencode(terminal_id, session_id, cache_blob)?;
                Ok(AgentSessionOpenResult {
                    runtime_incarnation: self.inner.incarnation,
                    key,
                    state,
                })
            }
        }
    }

    pub fn bind_agent_session(
        &self,
        agent: AgentTranscriptKind,
        terminal_id: String,
        session_id: String,
    ) -> Result<AgentSessionOpenResult, AgentSessionError> {
        let (key, state) = match agent {
            AgentTranscriptKind::Codex => self.inner.agents.bind_codex(terminal_id, session_id)?,
            AgentTranscriptKind::OpenCode => {
                self.inner.agents.bind_opencode(terminal_id, session_id)?
            }
        };
        Ok(AgentSessionOpenResult {
            runtime_incarnation: self.inner.incarnation,
            key,
            state,
        })
    }

    pub fn start_agent_session(
        &self,
        terminal_id: String,
        key: String,
        cache_blob: Option<Vec<u8>>,
    ) -> Result<AgentTranscriptState, AgentSessionError> {
        self.inner
            .agents
            .start_bound(&terminal_id, &key, cache_blob)
    }

    pub fn agent_transcript(&self, key: String) -> Result<AgentTranscriptState, AgentSessionError> {
        self.inner.agents.state(&key).ok_or_else(|| {
            AgentSessionError::SessionClosed(format!("agent transcript session {key} is closed"))
        })
    }

    pub fn close_agent_session(&self, key: String) {
        self.inner.agents.close_session(&key);
    }

    pub fn close_agent_terminal(&self, terminal_id: String) -> Option<String> {
        self.inner.agents.close_terminal(&terminal_id)
    }

    pub fn confirm_agent_transcript_cache(&self, confirmation_token: String) -> bool {
        self.inner.agents.confirm_cache(&confirmation_token)
    }

    pub async fn create_tab_with_launch(
        &self,
        workspace_id: String,
        label: String,
        launch: HerdrTabLaunch,
    ) -> Result<HerdrTabLaunchResult, HerdrControlError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HerdrControlError::TransportDisconnected)?
            .spawn(create_tab_with_launch_inner(
                inner,
                workspace_id,
                label,
                launch,
            ))
            .await
            .map_err(|error| {
                HerdrControlError::RequestCancelled(format!("host tab launch task failed: {error}"))
            })?
    }

    pub async fn submit_pastes(
        &self,
        pane_id: String,
        parts: Vec<String>,
    ) -> Result<(), HostRuntimeError> {
        let inner = self.inner.clone();
        crate::runtime()
            .map_err(HostRuntimeError::SshTransportFailure)?
            .spawn(submit_pastes_inner(inner, pane_id, parts))
            .await
            .map_err(|error| {
                HostRuntimeError::SshTransportFailure(format!(
                    "pane submission task failed: {error}"
                ))
            })?
    }

    pub async fn agent_integration_status(
        &self,
        kind: HerdrAgentKind,
    ) -> Result<AgentIntegrationStatus, HostRuntimeError> {
        let command = integration_status_command(&self.inner.config.herdr_command);
        let output = self.execute(command).await?;
        Ok(parse_agent_integration_status(&output, kind))
    }

    pub async fn install_agent_integration(
        &self,
        kind: HerdrAgentKind,
    ) -> Result<HerdrIntegrationInstallResult, HerdrControlError> {
        match self
            .control_request(HerdrControlRequest::IntegrationInstall { kind })
            .await?
        {
            HerdrControlResult::IntegrationInstalled { install } if install.kind == kind => {
                Ok(install)
            }
            HerdrControlResult::IntegrationInstalled { install } => {
                Err(HerdrControlError::UnsupportedResponse(format!(
                    "integration.install returned {:?} for requested {:?}",
                    install.kind, kind
                )))
            }
            _ => Err(HerdrControlError::UnsupportedResponse(
                "integration.install returned a non-integration result".to_owned(),
            )),
        }
    }
}
