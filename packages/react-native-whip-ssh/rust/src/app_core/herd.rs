//! Compact Herd projection over authoritative runtime snapshots.

use std::collections::HashMap;

use crate::herdr_api::{HerdrAgentInfo, HerdrAgentStatus, HerdrTabInfo, HerdrWorkspaceInfo};
use crate::host_state::HostSyncStatus;

use super::sessions::{AppConnectionStatus, AppCoreState};

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct HerdSessionMetadata {
    pub session_id: String,
    pub host_label: String,
    pub address: String,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HerdHostView {
    pub id: String,
    pub label: String,
    pub address: String,
    pub connected: bool,
    pub running: bool,
    pub refreshing: bool,
    pub agent_status: HerdrAgentStatus,
    pub agents: Vec<HerdrAgentInfo>,
    pub workspaces: Vec<HerdrWorkspaceInfo>,
    pub tabs: Vec<HerdrTabInfo>,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HerdAgentView {
    pub host_id: String,
    pub host_label: String,
    pub agent: HerdrAgentInfo,
    pub workspace_label: String,
    pub tab_label: String,
    pub primary_label: String,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct HerdView {
    pub revision: u64,
    pub selected_host_id: Option<String>,
    pub selected_workspace_id: Option<String>,
    pub hosts: Vec<HerdHostView>,
    pub agents: Vec<HerdAgentView>,
}

pub(super) fn project(
    state: &mut AppCoreState,
    metadata: Vec<HerdSessionMetadata>,
    requested_host_id: Option<String>,
    requested_workspace_id: Option<String>,
) -> HerdView {
    state.reconcile_selections();
    let metadata = metadata
        .into_iter()
        .map(|entry| (entry.session_id.clone(), entry))
        .collect::<HashMap<_, _>>();
    let mut hosts = state
        .sessions
        .iter()
        .map(|session| {
            let session_view = session.view();
            let host_state = session_view.host_state.as_ref();
            let snapshot = host_state.and_then(|state| state.snapshot.as_ref());
            let meta = metadata.get(&session.id);
            let agents = snapshot.map_or_else(Vec::new, |value| value.agents.clone());
            HerdHostView {
                id: session.id.clone(),
                label: meta
                    .map(|value| value.host_label.clone())
                    .unwrap_or_else(|| session.host_id.clone()),
                address: meta.map(|value| value.address.clone()).unwrap_or_default(),
                connected: matches!(
                    session_view.connection_status,
                    AppConnectionStatus::Connected | AppConnectionStatus::Ready
                ),
                running: snapshot.is_some(),
                refreshing: host_state
                    .is_some_and(|state| state.sync_status == HostSyncStatus::Syncing),
                agent_status: aggregate_status(agents.iter().map(|agent| agent.agent_status)),
                agents,
                workspaces: snapshot.map_or_else(Vec::new, |value| value.workspaces.clone()),
                tabs: snapshot.map_or_else(Vec::new, |value| value.tabs.clone()),
            }
        })
        .collect::<Vec<_>>();
    hosts.sort_by(|left, right| {
        right
            .connected
            .cmp(&left.connected)
            .then(status_priority(left.agent_status).cmp(&status_priority(right.agent_status)))
    });

    let selected_host_id = if hosts.len() == 1 {
        Some(hosts[0].id.clone())
    } else {
        requested_host_id.filter(|id| hosts.iter().any(|host| &host.id == id))
    };
    let selected_host = selected_host_id
        .as_ref()
        .and_then(|id| hosts.iter().find(|host| &host.id == id));
    let selected_workspace_id = selected_host.and_then(|host| {
        if host.workspaces.len() == 1 {
            Some(host.workspaces[0].workspace_id.clone())
        } else {
            requested_workspace_id
                .as_ref()
                .filter(|id| {
                    host.workspaces
                        .iter()
                        .any(|workspace| &workspace.workspace_id == *id)
                })
                .cloned()
        }
    });
    let scoped_hosts =
        selected_host.map_or_else(|| hosts.iter().collect::<Vec<_>>(), |host| vec![host]);
    let mut agents = scoped_hosts
        .into_iter()
        .flat_map(|host| {
            let tabs = host
                .tabs
                .iter()
                .map(|tab| (tab.tab_id.as_str(), tab))
                .collect::<HashMap<_, _>>();
            let workspaces = host
                .workspaces
                .iter()
                .map(|workspace| (workspace.workspace_id.as_str(), workspace))
                .collect::<HashMap<_, _>>();
            let tab_counts = host.tabs.iter().fold(HashMap::new(), |mut counts, tab| {
                *counts.entry(tab.workspace_id.as_str()).or_insert(0_u32) += 1;
                counts
            });
            host.agents
                .iter()
                .filter(|agent| {
                    selected_workspace_id
                        .as_ref()
                        .is_none_or(|id| &agent.workspace_id == id)
                })
                .map(|agent| {
                    let workspace_label = workspaces
                        .get(agent.workspace_id.as_str())
                        .map(|workspace| workspace.label.trim())
                        .filter(|label| !label.is_empty())
                        .unwrap_or(&agent.workspace_id)
                        .to_owned();
                    let tab_label = tabs
                        .get(agent.tab_id.as_str())
                        .map(|tab| tab.label.trim())
                        .filter(|label| !label.is_empty())
                        .unwrap_or(&agent.tab_id)
                        .to_owned();
                    let primary_label = if tab_counts
                        .get(agent.workspace_id.as_str())
                        .copied()
                        .unwrap_or_default()
                        > 1
                    {
                        format!("{workspace_label} · {tab_label}")
                    } else {
                        workspace_label.clone()
                    };
                    HerdAgentView {
                        host_id: host.id.clone(),
                        host_label: host.label.clone(),
                        agent: agent.clone(),
                        workspace_label,
                        tab_label,
                        primary_label,
                    }
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    agents.sort_by(|left, right| {
        status_priority(left.agent.agent_status)
            .cmp(&status_priority(right.agent.agent_status))
            .then_with(|| {
                right
                    .agent
                    .state_change_seq
                    .partial_cmp(&left.agent.state_change_seq)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    HerdView {
        revision: state.revision,
        selected_host_id,
        selected_workspace_id,
        hosts,
        agents,
    }
}

fn aggregate_status(statuses: impl Iterator<Item = HerdrAgentStatus>) -> HerdrAgentStatus {
    statuses
        .min_by_key(|status| status_priority(*status))
        .unwrap_or(HerdrAgentStatus::Idle)
}

fn status_priority(status: HerdrAgentStatus) -> u8 {
    match status {
        HerdrAgentStatus::Blocked => 0,
        HerdrAgentStatus::Done => 1,
        HerdrAgentStatus::Working => 2,
        HerdrAgentStatus::Idle => 3,
        HerdrAgentStatus::Unknown => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_order_is_blocked_done_working_idle_unknown() {
        let mut statuses = [
            HerdrAgentStatus::Idle,
            HerdrAgentStatus::Unknown,
            HerdrAgentStatus::Working,
            HerdrAgentStatus::Blocked,
            HerdrAgentStatus::Done,
        ];
        statuses.sort_by_key(|status| status_priority(*status));
        assert_eq!(
            statuses,
            [
                HerdrAgentStatus::Blocked,
                HerdrAgentStatus::Done,
                HerdrAgentStatus::Working,
                HerdrAgentStatus::Idle,
                HerdrAgentStatus::Unknown,
            ]
        );
    }
}
