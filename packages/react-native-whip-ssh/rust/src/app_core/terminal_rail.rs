use std::collections::HashMap;

use crate::herdr_api::{HerdrPaneInfo, HerdrSessionSnapshot};
use crate::host_runtime::HostTerminalState;

pub const SSH_SHELL_TERMINAL_ID: &str = "__whip_ssh_shell__";

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum TerminalKind {
    Herdr,
    Ssh,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum TerminalUiState {
    Connecting,
    Connected,
    Disconnected,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct TerminalEntryView {
    pub terminal_id: String,
    pub pane_id: String,
    pub title: String,
    pub kind: TerminalKind,
    pub state: TerminalUiState,
    pub error: Option<String>,
    pub reconnect_attempt: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, uniffi::Record)]
pub struct TerminalRailView {
    pub terminals: Vec<TerminalEntryView>,
    pub active_terminal_id: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub(super) struct TerminalRail {
    terminals: Vec<TerminalEntryView>,
    active_terminal_id: Option<String>,
}

impl TerminalRail {
    pub(super) fn view(&self) -> TerminalRailView {
        TerminalRailView {
            terminals: self.terminals.clone(),
            active_terminal_id: self.active_terminal_id.clone(),
        }
    }

    pub(super) fn restore(
        &mut self,
        terminal_ids: Vec<String>,
        active_terminal_id: Option<String>,
        snapshot: &HerdrSessionSnapshot,
    ) -> bool {
        let panes_by_terminal: HashMap<_, _> = snapshot
            .panes
            .iter()
            .map(|pane| (pane.terminal_id.as_str(), pane))
            .collect();
        let mut terminals = Vec::new();
        for terminal_id in terminal_ids {
            if terminals
                .iter()
                .any(|terminal: &TerminalEntryView| terminal.terminal_id == terminal_id)
            {
                continue;
            }
            if let Some(pane) = panes_by_terminal.get(terminal_id.as_str()) {
                terminals.push(entry_for_pane(pane));
            }
        }
        let selected = active_terminal_id
            .filter(|active| {
                terminals
                    .iter()
                    .any(|terminal| terminal.terminal_id == *active)
            })
            .or_else(|| {
                terminals
                    .first()
                    .map(|terminal| terminal.terminal_id.clone())
            });
        self.terminals = terminals;
        self.active_terminal_id = selected;
        if let Some(focused) = snapshot
            .focused_pane_id
            .as_deref()
            .and_then(|id| snapshot.panes.iter().find(|pane| pane.pane_id == id))
            .or_else(|| snapshot.panes.iter().find(|pane| pane.focused))
        {
            self.open_pane(focused);
        }
        true
    }

    pub(super) fn open_pane(&mut self, pane: &HerdrPaneInfo) -> bool {
        if let Some(existing) = self
            .terminals
            .iter_mut()
            .find(|terminal| terminal.terminal_id == pane.terminal_id)
        {
            let pane_id = pane.pane_id.clone();
            let title = title_for_pane(pane);
            let changed = existing.pane_id != pane_id
                || existing.title != title
                || self.active_terminal_id.as_deref() != Some(pane.terminal_id.as_str());
            existing.pane_id = pane_id;
            existing.title = title;
            self.active_terminal_id = Some(pane.terminal_id.clone());
            return changed;
        }
        self.terminals.push(entry_for_pane(pane));
        self.active_terminal_id = Some(pane.terminal_id.clone());
        true
    }

    pub(super) fn open_ssh_shell(&mut self, title: String) -> bool {
        if let Some(existing) = self
            .terminals
            .iter_mut()
            .find(|terminal| terminal.kind == TerminalKind::Ssh)
        {
            let changed = existing.title != title
                || self.active_terminal_id.as_deref() != Some(SSH_SHELL_TERMINAL_ID);
            existing.title = title;
            self.active_terminal_id = Some(SSH_SHELL_TERMINAL_ID.to_owned());
            return changed;
        }
        self.terminals.push(TerminalEntryView {
            terminal_id: SSH_SHELL_TERMINAL_ID.to_owned(),
            pane_id: SSH_SHELL_TERMINAL_ID.to_owned(),
            title,
            kind: TerminalKind::Ssh,
            state: TerminalUiState::Connecting,
            error: None,
            reconnect_attempt: 0,
        });
        self.active_terminal_id = Some(SSH_SHELL_TERMINAL_ID.to_owned());
        true
    }

    pub(super) fn close(&mut self, terminal_id: &str) -> bool {
        let Some(index) = self
            .terminals
            .iter()
            .position(|terminal| terminal.terminal_id == terminal_id)
        else {
            return false;
        };
        self.terminals.remove(index);
        if self.active_terminal_id.as_deref() == Some(terminal_id) {
            self.active_terminal_id = self
                .terminals
                .get(index.min(self.terminals.len().saturating_sub(1)))
                .map(|terminal| terminal.terminal_id.clone());
        }
        true
    }

    pub(super) fn reconcile(&mut self, snapshot: &HerdrSessionSnapshot) -> bool {
        let panes_by_terminal: HashMap<_, _> = snapshot
            .panes
            .iter()
            .map(|pane| (pane.terminal_id.as_str(), pane))
            .collect();
        let previous_active_index = self
            .terminals
            .iter()
            .position(|terminal| {
                Some(terminal.terminal_id.as_str()) == self.active_terminal_id.as_deref()
            })
            .unwrap_or_default();
        let mut changed = false;
        self.terminals.retain_mut(|terminal| {
            if terminal.kind == TerminalKind::Ssh {
                return true;
            }
            let Some(pane) = panes_by_terminal.get(terminal.terminal_id.as_str()) else {
                changed = true;
                return false;
            };
            let pane_id = pane.pane_id.clone();
            let title = title_for_pane(pane);
            if terminal.pane_id != pane_id || terminal.title != title {
                terminal.pane_id = pane_id;
                terminal.title = title;
                changed = true;
            }
            true
        });
        if !self.terminals.iter().any(|terminal| {
            Some(terminal.terminal_id.as_str()) == self.active_terminal_id.as_deref()
        }) {
            self.active_terminal_id = self
                .terminals
                .get(previous_active_index.min(self.terminals.len().saturating_sub(1)))
                .map(|terminal| terminal.terminal_id.clone());
            changed = true;
        }
        changed
    }

    pub(super) fn update_lifecycle(
        &mut self,
        terminal_id: &str,
        state: HostTerminalState,
        retrying: bool,
        error: Option<String>,
        reconnect_attempt: u32,
    ) -> bool {
        let Some(terminal) = self
            .terminals
            .iter_mut()
            .find(|terminal| terminal.terminal_id == terminal_id)
        else {
            return false;
        };
        let state = match state {
            HostTerminalState::Opening => TerminalUiState::Connecting,
            HostTerminalState::Attached => TerminalUiState::Connected,
            HostTerminalState::Failed if !retrying => TerminalUiState::Error,
            HostTerminalState::Restoring
            | HostTerminalState::Closed
            | HostTerminalState::Failed => TerminalUiState::Disconnected,
        };
        if terminal.state == state
            && terminal.error == error
            && terminal.reconnect_attempt == reconnect_attempt
        {
            return false;
        }
        terminal.state = state;
        terminal.error = error;
        terminal.reconnect_attempt = if state == TerminalUiState::Connected {
            0
        } else {
            reconnect_attempt
        };
        true
    }
}

fn entry_for_pane(pane: &HerdrPaneInfo) -> TerminalEntryView {
    TerminalEntryView {
        terminal_id: pane.terminal_id.clone(),
        pane_id: pane.pane_id.clone(),
        title: title_for_pane(pane),
        kind: TerminalKind::Herdr,
        state: TerminalUiState::Connecting,
        error: None,
        reconnect_attempt: 0,
    }
}

fn title_for_pane(pane: &HerdrPaneInfo) -> String {
    pane.label
        .as_deref()
        .filter(|label| !label.is_empty())
        .or_else(|| {
            pane.display_agent
                .as_deref()
                .filter(|agent| !agent.is_empty())
        })
        .or_else(|| pane.agent.as_deref().filter(|agent| !agent.is_empty()))
        .unwrap_or(&pane.pane_id)
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::herdr_api::{HerdrAgentStatus, HerdrSessionSnapshot};

    fn pane(terminal_id: &str, pane_id: &str, label: &str) -> HerdrPaneInfo {
        HerdrPaneInfo {
            pane_id: pane_id.to_owned(),
            terminal_id: terminal_id.to_owned(),
            workspace_id: "workspace".to_owned(),
            tab_id: "tab".to_owned(),
            focused: false,
            cwd: None,
            foreground_cwd: None,
            label: Some(label.to_owned()),
            agent: None,
            title: None,
            terminal_title: None,
            terminal_title_stripped: None,
            display_agent: None,
            agent_status: HerdrAgentStatus::Idle,
            state_labels: None,
            tokens: None,
            agent_session: None,
            scroll: None,
            revision: 1.0,
        }
    }

    fn snapshot(panes: Vec<HerdrPaneInfo>) -> HerdrSessionSnapshot {
        HerdrSessionSnapshot {
            version: "1".to_owned(),
            protocol: 22,
            focused_workspace_id: None,
            focused_tab_id: None,
            focused_pane_id: None,
            agents: Vec::new(),
            workspaces: Vec::new(),
            tabs: Vec::new(),
            panes,
            layouts: Vec::new(),
        }
    }

    #[test]
    fn reopening_existing_terminal_updates_metadata_and_selects_it() {
        let mut rail = TerminalRail::default();
        rail.open_pane(&pane("one", "pane-one", "old"));
        rail.open_pane(&pane("two", "pane-two", "two"));

        rail.open_pane(&pane("one", "pane-one-new", "renamed"));

        assert_eq!(rail.terminals.len(), 2);
        assert_eq!(rail.terminals[0].pane_id, "pane-one-new");
        assert_eq!(rail.terminals[0].title, "renamed");
        assert_eq!(rail.active_terminal_id.as_deref(), Some("one"));
    }

    #[test]
    fn removing_active_middle_terminal_selects_nearest_survivor() {
        let mut rail = TerminalRail::default();
        rail.open_pane(&pane("one", "pane-one", "one"));
        rail.open_pane(&pane("two", "pane-two", "two"));
        rail.open_pane(&pane("three", "pane-three", "three"));
        rail.active_terminal_id = Some("two".to_owned());

        rail.close("two");

        assert_eq!(
            rail.terminals
                .iter()
                .map(|terminal| terminal.terminal_id.as_str())
                .collect::<Vec<_>>(),
            ["one", "three"]
        );
        assert_eq!(rail.active_terminal_id.as_deref(), Some("three"));
    }

    #[test]
    fn pane_reconciliation_removes_missing_terminal_and_keeps_ssh_shell() {
        let mut rail = TerminalRail::default();
        rail.open_pane(&pane("gone", "pane-gone", "gone"));
        rail.open_ssh_shell("SSH shell".to_owned());
        rail.active_terminal_id = Some("gone".to_owned());

        rail.reconcile(&snapshot(Vec::new()));

        assert_eq!(rail.terminals.len(), 1);
        assert_eq!(rail.terminals[0].kind, TerminalKind::Ssh);
        assert_eq!(
            rail.active_terminal_id.as_deref(),
            Some(SSH_SHELL_TERMINAL_ID)
        );
    }

    #[test]
    fn lifecycle_projection_tracks_reconnect_and_clears_attempt_when_connected() {
        let mut rail = TerminalRail::default();
        rail.open_pane(&pane("one", "pane-one", "one"));

        rail.update_lifecycle(
            "one",
            HostTerminalState::Failed,
            true,
            Some("lost".to_owned()),
            2,
        );
        assert_eq!(rail.terminals[0].state, TerminalUiState::Disconnected);
        assert_eq!(rail.terminals[0].reconnect_attempt, 2);
        rail.update_lifecycle("one", HostTerminalState::Attached, false, None, 2);

        assert_eq!(rail.terminals[0].state, TerminalUiState::Connected);
        assert_eq!(rail.terminals[0].reconnect_attempt, 0);
        assert_eq!(rail.terminals[0].error, None);
    }

    #[test]
    fn restore_discards_invalid_and_duplicate_terminal_ids() {
        let mut rail = TerminalRail::default();
        let current = pane("valid", "pane-valid", "valid");

        rail.restore(
            vec!["missing".to_owned(), "valid".to_owned(), "valid".to_owned()],
            Some("missing".to_owned()),
            &snapshot(vec![current]),
        );

        assert_eq!(rail.terminals.len(), 1);
        assert_eq!(rail.terminals[0].terminal_id, "valid");
        assert_eq!(rail.active_terminal_id.as_deref(), Some("valid"));
    }
}
