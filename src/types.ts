export type AuthMode = 'password' | 'key';
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface HostProfile {
  id: string;
  name: string;
  host: string;
  port: string;
  username: string;
  authMode: AuthMode;
  herdrCommand: string;
  sessionName: string;
  rememberCredentials: boolean;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt?: string;
}

export interface ConnectionProfile extends HostProfile {
  secret: string;
  passphrase: string;
}

export interface AgentInfo {
  terminal_id: string;
  name?: string;
  agent?: string;
  title?: string;
  display_agent?: string;
  custom_status?: string;
  agent_status: AgentStatus;
  workspace_id: string;
  tab_id: string;
  pane_id: string;
  focused: boolean;
  cwd?: string;
  foreground_cwd?: string;
  revision: number;
  state_labels?: Record<string, string>;
}

export interface WorkspaceInfo {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  agent_status: AgentStatus;
  worktree?: {
    repo_name: string;
    checkout_path: string;
    is_linked_worktree: boolean;
  };
}

export interface TabInfo {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  agent_status: AgentStatus;
}

export interface PaneInfo {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  cwd?: string;
  foreground_cwd?: string;
  label?: string;
  agent?: string;
  title?: string;
  display_agent?: string;
  agent_status: AgentStatus;
  custom_status?: string;
  state_labels?: Record<string, string>;
  revision: number;
}

export interface ServerInfo {
  running: boolean;
  version?: string;
  protocol?: number;
  compatible?: boolean;
  socket?: string;
}

export interface HerdrSnapshot {
  server: ServerInfo;
  agents: AgentInfo[];
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
  panes: PaneInfo[];
}

export type AppTab = 'hosts' | 'herd' | 'terminal' | 'more';
export type AppScreen = 'settings';
