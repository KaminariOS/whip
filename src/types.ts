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
  herdrSocketPath?: string;
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

export interface GlobalSshKey {
  id: string;
  name: string;
  fingerprint: string;
  keyType: string;
  createdAt: string;
  updatedAt: string;
}

export interface GlobalSshKeyMaterial extends GlobalSshKey {
  secret: string;
  passphrase: string;
}

export interface AgentInfo {
  terminal_id: string;
  name?: string;
  agent?: string;
  title?: string;
  terminal_title?: string;
  terminal_title_stripped?: string;
  display_agent?: string;
  custom_status?: string;
  agent_status: AgentStatus;
  workspace_id: string;
  tab_id: string;
  pane_id: string;
  focused: boolean;
  cwd?: string;
  foreground_cwd?: string;
  screen_detection_skipped?: boolean;
  tokens?: Record<string, string>;
  agent_session?: AgentSessionInfo;
  launch_pending?: boolean;
  interactive_ready?: boolean;
  state_change_seq?: number;
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
  tokens?: Record<string, string>;
  worktree?: {
    repo_key?: string;
    repo_name: string;
    repo_root?: string;
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
  terminal_title?: string;
  terminal_title_stripped?: string;
  display_agent?: string;
  agent_status: AgentStatus;
  custom_status?: string;
  state_labels?: Record<string, string>;
  tokens?: Record<string, string>;
  agent_session?: AgentSessionInfo;
  scroll?: PaneScrollInfo;
  revision: number;
}

export interface AgentSessionInfo {
  source: string;
  agent: string;
  kind: string;
  value: string;
}

export interface PaneScrollInfo {
  offset_from_bottom: number;
  max_offset_from_bottom: number;
  viewport_rows: number;
}

export interface PaneLayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaneLayoutPane {
  pane_id: string;
  focused: boolean;
  rect: PaneLayoutRect;
}

export interface PaneLayoutSplit {
  id: string;
  direction: 'right' | 'down';
  ratio: number;
  rect: PaneLayoutRect;
}

export interface PaneLayoutSnapshot {
  workspace_id: string;
  tab_id: string;
  zoomed: boolean;
  area: PaneLayoutRect;
  focused_pane_id: string;
  panes: PaneLayoutPane[];
  splits: PaneLayoutSplit[];
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
  focused_workspace_id: string | null;
  focused_tab_id: string | null;
  focused_pane_id: string | null;
  agents: AgentInfo[];
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
  panes: PaneInfo[];
  layouts: PaneLayoutSnapshot[];
}

export type AppTab = 'hosts' | 'herd' | 'terminal' | 'more';
