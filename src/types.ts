import type {
  AgentInfo as ApiAgentInfo,
  AgentSessionInfo as ApiAgentSessionInfo,
  AgentStatus as ApiAgentStatus,
  PaneInfo as ApiPaneInfo,
  PaneLayoutPane as ApiPaneLayoutPane,
  PaneLayoutRect as ApiPaneLayoutRect,
  PaneLayoutSnapshot as ApiPaneLayoutSnapshot,
  PaneLayoutSplit as ApiPaneLayoutSplit,
  PaneScrollInfo as ApiPaneScrollInfo,
  SessionSnapshot as ApiSessionSnapshot,
  TabInfo as ApiTabInfo,
  WorkspaceInfo as ApiWorkspaceInfo,
} from './generated/herdrApi';

export type AuthMode = 'password' | 'key';
export type AgentStatus = ApiAgentStatus;

export interface HostProfile {
  id: string;
  name: string;
  host: string;
  port: string;
  username: string;
  jumpHostId?: string;
  forwardAgent?: boolean;
  authMode: AuthMode;
  herdrCommand: string;
  herdrSocketPath?: string;
  sessionName: string;
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

export interface KnownHost {
  id: string;
  host: string;
  port: number;
  keyType: string;
  publicKey: string;
  fingerprint: string;
  createdAt: string;
}

export type AgentInfo = ApiAgentInfo;
export type WorkspaceInfo = ApiWorkspaceInfo;
export type TabInfo = ApiTabInfo;
export type PaneInfo = ApiPaneInfo;
export type AgentSessionInfo = ApiAgentSessionInfo;
export type PaneScrollInfo = ApiPaneScrollInfo;
export type PaneLayoutRect = ApiPaneLayoutRect;
export type PaneLayoutPane = ApiPaneLayoutPane;
export type PaneLayoutSplit = ApiPaneLayoutSplit;
export type PaneLayoutSnapshot = ApiPaneLayoutSnapshot;

export interface ServerInfo {
  running: boolean;
  version?: string;
  protocol?: number;
  compatible?: boolean;
  socket?: string;
}

export interface HerdrSnapshot
  extends Pick<
    ApiSessionSnapshot,
    'agents' | 'workspaces' | 'tabs' | 'panes' | 'layouts'
  > {
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
