import type { AgentStatusUpdate } from './agentStatusEvents';
import { agentStatusFromEvent } from './agentStatusEvents';
import type { EventData, WorktreeInfo } from '../generated/herdrApi';
import type {
  AgentSessionInfo,
  PaneInfo,
  PaneLayoutRect,
  PaneLayoutSnapshot,
  PaneScrollInfo,
  TabInfo,
  WorkspaceInfo,
} from '../types';

type DotEventName<Name extends string> =
  Name extends `${infer Scope}_${infer EventName}` ? `${Scope}.${EventName}` : Name;

type DecodedEventData<Data extends { type: string }> = {
  [Key in keyof Omit<Data, 'type'>]: Exclude<Omit<Data, 'type'>[Key], null>;
};

type OfficialHerdrEvent<Data extends { type: string } = EventData> =
  Data extends EventData
    ? { event: DotEventName<Data['type']>; data: DecodedEventData<Data> }
    : never;

export type PaneAgentStatusChangedData = Extract<
  OfficialHerdrEvent,
  { event: 'pane.agent_status_changed' }
>['data'];

export type HerdrEvent =
  | OfficialHerdrEvent
  | Event<'protocol.unknown', { raw_event: string }>
  | Event<'protocol.invalid', { raw_event: string; reason: string }>;

type Event<Name extends string, Data> = { event: Name; data: Data };

const EVENT_NAMES = new Set<Exclude<HerdrEvent['event'], `protocol.${string}`>>([
  'workspace.created',
  'workspace.updated',
  'workspace.metadata_updated',
  'workspace.closed',
  'workspace.renamed',
  'workspace.moved',
  'workspace.reordered',
  'workspace.focused',
  'worktree.created',
  'worktree.opened',
  'worktree.removed',
  'tab.created',
  'tab.closed',
  'tab.renamed',
  'tab.moved',
  'tab.focused',
  'pane.created',
  'pane.updated',
  'pane.closed',
  'pane.focused',
  'pane.exited',
  'pane.moved',
  'pane.output_changed',
  'pane.agent_detected',
  'pane.agent_status_changed',
  'layout.updated',
]);

/** Decode one untrusted protocol envelope before application code sees it. */
export function decodeHerdrEvent(rawEvent: string, value: unknown): HerdrEvent {
  const event = normalizeEventName(rawEvent);
  if (!event) return { event: 'protocol.unknown', data: { raw_event: rawEvent } };

  try {
    const data = record(value, 'event data');
    validateDataDiscriminator(data, event);

    switch (event) {
      case 'workspace.created':
      case 'workspace.updated':
      case 'workspace.metadata_updated':
        return { event, data: { workspace: workspace(data.workspace) } };
      case 'workspace.closed':
        return {
          event,
          data: {
            workspace_id: nonEmptyString(data.workspace_id, 'workspace_id'),
            ...optionalDecoded(data, 'workspace', workspace),
          },
        };
      case 'workspace.renamed':
        return {
          event,
          data: {
            workspace_id: nonEmptyString(data.workspace_id, 'workspace_id'),
            label: string(data.label, 'label'),
          },
        };
      case 'workspace.moved':
        return {
          event,
          data: {
            workspace_id: nonEmptyString(data.workspace_id, 'workspace_id'),
            insert_index: nonNegativeNumber(data.insert_index, 'insert_index'),
            workspaces: array(data.workspaces, 'workspaces', workspace),
          },
        };
      case 'workspace.reordered':
        return {
          event,
          data: {
            workspace_ids: array(data.workspace_ids, 'workspace_ids', nonEmptyString),
            workspaces: array(data.workspaces, 'workspaces', workspace),
            ...optionalString(data, 'before_workspace_id'),
          },
        };
      case 'workspace.focused':
        return { event, data: { workspace_id: nonEmptyString(data.workspace_id, 'workspace_id') } };
      case 'worktree.created':
        return {
          event,
          data: { workspace: workspace(data.workspace), worktree: worktree(data.worktree) },
        };
      case 'worktree.opened':
        return {
          event,
          data: {
            workspace: workspace(data.workspace),
            worktree: worktree(data.worktree),
            already_open: boolean(data.already_open, 'already_open'),
          },
        };
      case 'worktree.removed':
        return {
          event,
          data: {
            workspace_id: nonEmptyString(data.workspace_id, 'workspace_id'),
            ...optionalDecoded(data, 'workspace', workspace),
            worktree: worktree(data.worktree),
            forced: boolean(data.forced, 'forced'),
          },
        };
      case 'tab.created':
        return { event, data: { tab: tab(data.tab) } };
      case 'tab.closed':
      case 'tab.focused':
        return {
          event,
          data: {
            workspace_id: nonEmptyString(data.workspace_id, 'workspace_id'),
            tab_id: nonEmptyString(data.tab_id, 'tab_id'),
          },
        };
      case 'tab.renamed':
        return {
          event,
          data: {
            workspace_id: nonEmptyString(data.workspace_id, 'workspace_id'),
            tab_id: nonEmptyString(data.tab_id, 'tab_id'),
            label: string(data.label, 'label'),
          },
        };
      case 'tab.moved':
        return {
          event,
          data: {
            workspace_id: nonEmptyString(data.workspace_id, 'workspace_id'),
            tab_id: nonEmptyString(data.tab_id, 'tab_id'),
            insert_index: nonNegativeNumber(data.insert_index, 'insert_index'),
            tabs: array(data.tabs, 'tabs', tab),
          },
        };
      case 'pane.created':
      case 'pane.updated':
        return { event, data: { pane: pane(data.pane) } };
      case 'pane.closed':
      case 'pane.focused':
      case 'pane.exited':
        return {
          event,
          data: {
            workspace_id: nonEmptyString(data.workspace_id, 'workspace_id'),
            pane_id: nonEmptyString(data.pane_id, 'pane_id'),
          },
        };
      case 'pane.moved':
        return {
          event,
          data: {
            previous_pane_id: nonEmptyString(data.previous_pane_id, 'previous_pane_id'),
            previous_workspace_id: nonEmptyString(
              data.previous_workspace_id,
              'previous_workspace_id',
            ),
            previous_tab_id: nonEmptyString(data.previous_tab_id, 'previous_tab_id'),
            pane: pane(data.pane),
            ...optionalDecoded(data, 'created_workspace', workspace),
            ...optionalDecoded(data, 'created_tab', tab),
            ...optionalString(data, 'closed_workspace_id'),
            ...optionalString(data, 'closed_tab_id'),
          },
        };
      case 'pane.output_changed':
        return {
          event,
          data: {
            workspace_id: nonEmptyString(data.workspace_id, 'workspace_id'),
            pane_id: nonEmptyString(data.pane_id, 'pane_id'),
            revision: nonNegativeNumber(data.revision, 'revision'),
          },
        };
      case 'pane.agent_detected':
        return {
          event,
          data: {
            workspace_id: nonEmptyString(data.workspace_id, 'workspace_id'),
            pane_id: nonEmptyString(data.pane_id, 'pane_id'),
            ...optionalString(data, 'agent'),
            released: optionalBoolean(data, 'released') ?? false,
            ...optionalAgentStatus(data, 'final_status'),
          },
        };
      case 'pane.agent_status_changed':
        return { event, data: paneAgentStatusChanged(data) };
      case 'layout.updated':
        return { event, data: { layout: paneLayout(data.layout) } };
    }
  } catch (error) {
    return {
      event: 'protocol.invalid',
      data: {
        raw_event: rawEvent,
        reason: error instanceof Error ? error.message : 'invalid event data',
      },
    };
  }
}

function normalizeEventName(
  rawEvent: string,
): Exclude<HerdrEvent['event'], `protocol.${string}`> | null {
  const normalized = rawEvent.includes('.')
    ? rawEvent
    : rawEvent.replace(/_/, '.');
  return EVENT_NAMES.has(normalized as Exclude<HerdrEvent['event'], `protocol.${string}`>)
    ? normalized as Exclude<HerdrEvent['event'], `protocol.${string}`>
    : null;
}

function validateDataDiscriminator(
  data: Record<string, unknown>,
  event: Exclude<HerdrEvent['event'], `protocol.${string}`>,
): void {
  if (data.type === undefined) return;
  const expected = event.replace('.', '_');
  if (data.type !== expected) fail(`type must be ${expected}`);
}

function workspace(value: unknown, label = 'workspace'): WorkspaceInfo {
  const item = record(value, label);
  return {
    workspace_id: nonEmptyString(item.workspace_id, `${label}.workspace_id`),
    number: nonNegativeNumber(item.number, `${label}.number`),
    label: string(item.label, `${label}.label`),
    focused: boolean(item.focused, `${label}.focused`),
    pane_count: nonNegativeNumber(item.pane_count, `${label}.pane_count`),
    tab_count: nonNegativeNumber(item.tab_count, `${label}.tab_count`),
    active_tab_id: string(item.active_tab_id, `${label}.active_tab_id`),
    agent_status: agentStatus(item.agent_status, `${label}.agent_status`),
    ...optionalStringRecord(item, 'tokens', label),
    ...optionalDecoded(item, 'worktree', workspaceWorktree, label),
  };
}

function workspaceWorktree(value: unknown, label = 'worktree'): NonNullable<WorkspaceInfo['worktree']> {
  const item = record(value, label);
  return {
    repo_key: nonEmptyString(item.repo_key, `${label}.repo_key`),
    repo_name: nonEmptyString(item.repo_name, `${label}.repo_name`),
    repo_root: nonEmptyString(item.repo_root, `${label}.repo_root`),
    checkout_path: nonEmptyString(item.checkout_path, `${label}.checkout_path`),
    is_linked_worktree: boolean(item.is_linked_worktree, `${label}.is_linked_worktree`),
  };
}

function worktree(value: unknown, label = 'worktree'): WorktreeInfo {
  const item = record(value, label);
  return {
    ...optionalString(item, 'branch', label),
    is_bare: boolean(item.is_bare, `${label}.is_bare`),
    is_detached: boolean(item.is_detached, `${label}.is_detached`),
    is_linked_worktree: boolean(item.is_linked_worktree, `${label}.is_linked_worktree`),
    is_prunable: boolean(item.is_prunable, `${label}.is_prunable`),
    label: string(item.label, `${label}.label`),
    ...optionalString(item, 'open_workspace_id', label),
    path: nonEmptyString(item.path, `${label}.path`),
  };
}

function tab(value: unknown, label = 'tab'): TabInfo {
  const item = record(value, label);
  return {
    tab_id: nonEmptyString(item.tab_id, `${label}.tab_id`),
    workspace_id: nonEmptyString(item.workspace_id, `${label}.workspace_id`),
    number: nonNegativeNumber(item.number, `${label}.number`),
    label: string(item.label, `${label}.label`),
    focused: boolean(item.focused, `${label}.focused`),
    pane_count: nonNegativeNumber(item.pane_count, `${label}.pane_count`),
    agent_status: agentStatus(item.agent_status, `${label}.agent_status`),
  };
}

function pane(value: unknown, label = 'pane'): PaneInfo {
  const item = record(value, label);
  return {
    pane_id: nonEmptyString(item.pane_id, `${label}.pane_id`),
    terminal_id: nonEmptyString(item.terminal_id, `${label}.terminal_id`),
    workspace_id: nonEmptyString(item.workspace_id, `${label}.workspace_id`),
    tab_id: nonEmptyString(item.tab_id, `${label}.tab_id`),
    focused: boolean(item.focused, `${label}.focused`),
    ...optionalString(item, 'cwd', label),
    ...optionalString(item, 'foreground_cwd', label),
    ...optionalString(item, 'label', label),
    ...optionalString(item, 'agent', label),
    ...optionalString(item, 'title', label),
    ...optionalString(item, 'terminal_title', label),
    ...optionalString(item, 'terminal_title_stripped', label),
    ...optionalString(item, 'display_agent', label),
    agent_status: agentStatus(item.agent_status, `${label}.agent_status`),
    ...optionalStringRecord(item, 'state_labels', label),
    ...optionalStringRecord(item, 'tokens', label),
    ...optionalDecoded(item, 'agent_session', agentSession, label),
    ...optionalDecoded(item, 'scroll', paneScroll, label),
    revision: nonNegativeNumber(item.revision, `${label}.revision`),
  };
}

function agentSession(value: unknown, label = 'agent_session'): AgentSessionInfo {
  const item = record(value, label);
  return {
    source: nonEmptyString(item.source, `${label}.source`),
    agent: nonEmptyString(item.agent, `${label}.agent`),
    kind: agentSessionKind(item.kind, `${label}.kind`),
    value: string(item.value, `${label}.value`),
  };
}

function paneScroll(value: unknown, label = 'scroll'): PaneScrollInfo {
  const item = record(value, label);
  return {
    offset_from_bottom: nonNegativeNumber(
      item.offset_from_bottom,
      `${label}.offset_from_bottom`,
    ),
    max_offset_from_bottom: nonNegativeNumber(
      item.max_offset_from_bottom,
      `${label}.max_offset_from_bottom`,
    ),
    viewport_rows: nonNegativeNumber(item.viewport_rows, `${label}.viewport_rows`),
  };
}

function paneLayout(value: unknown, label = 'layout'): PaneLayoutSnapshot {
  const item = record(value, label);
  return {
    workspace_id: nonEmptyString(item.workspace_id, `${label}.workspace_id`),
    tab_id: nonEmptyString(item.tab_id, `${label}.tab_id`),
    zoomed: boolean(item.zoomed, `${label}.zoomed`),
    area: paneRect(item.area, `${label}.area`),
    focused_pane_id: nonEmptyString(item.focused_pane_id, `${label}.focused_pane_id`),
    panes: array(item.panes, `${label}.panes`, (entry, entryLabel) => {
      const paneItem = record(entry, entryLabel);
      return {
        pane_id: nonEmptyString(paneItem.pane_id, `${entryLabel}.pane_id`),
        focused: boolean(paneItem.focused, `${entryLabel}.focused`),
        rect: paneRect(paneItem.rect, `${entryLabel}.rect`),
      };
    }),
    splits: array(item.splits, `${label}.splits`, (entry, entryLabel) => {
      const split = record(entry, entryLabel);
      const direction = split.direction;
      if (direction !== 'right' && direction !== 'down') {
        fail(`${entryLabel}.direction must be right or down`);
      }
      return {
        id: nonEmptyString(split.id, `${entryLabel}.id`),
        direction,
        ratio: finiteNumber(split.ratio, `${entryLabel}.ratio`),
        rect: paneRect(split.rect, `${entryLabel}.rect`),
      };
    }),
  };
}

function paneRect(value: unknown, label: string): PaneLayoutRect {
  const item = record(value, label);
  return {
    x: finiteNumber(item.x, `${label}.x`),
    y: finiteNumber(item.y, `${label}.y`),
    width: nonNegativeNumber(item.width, `${label}.width`),
    height: nonNegativeNumber(item.height, `${label}.height`),
  };
}

function paneAgentStatusChanged(data: Record<string, unknown>): PaneAgentStatusChangedData {
  return {
    workspace_id: nonEmptyString(data.workspace_id, 'workspace_id'),
    pane_id: nonEmptyString(data.pane_id, 'pane_id'),
    agent_status: agentStatus(data.agent_status, 'agent_status'),
    ...optionalString(data, 'agent'),
    ...optionalString(data, 'title'),
    ...optionalString(data, 'display_agent'),
    ...optionalStringRecord(data, 'state_labels'),
  };
}

function agentSessionKind(value: unknown, label: string): AgentSessionInfo['kind'] {
  if (value !== 'id' && value !== 'path') fail(`${label} must be id or path`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  const decoded = string(value, label);
  if (!decoded) fail(`${label} must not be empty`);
  return decoded;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a finite number`);
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  const decoded = finiteNumber(value, label);
  if (decoded < 0) fail(`${label} must be non-negative`);
  return decoded;
}

function agentStatus(value: unknown, label: string): AgentStatusUpdate['agent_status'] {
  const decoded = agentStatusFromEvent(value);
  if (!decoded) fail(`${label} is invalid`);
  return decoded;
}

function array<T>(
  value: unknown,
  label: string,
  decode: (entry: unknown, label: string) => T,
): T[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value.map((entry, index) => decode(entry, `${label}[${index}]`));
}

function optionalDecoded<Key extends string, T>(
  item: Record<string, unknown>,
  key: Key,
  decode: (value: unknown, label: string) => T,
  parentLabel?: string,
): Partial<Record<Key, T>> {
  const value = item[key];
  if (value === undefined) return {};
  const label = parentLabel ? `${parentLabel}.${key}` : key;
  return { [key]: decode(value, label) } as Partial<Record<Key, T>>;
}

function optionalString<Key extends string>(
  item: Record<string, unknown>,
  key: Key,
  parentLabel?: string,
): Partial<Record<Key, string>> {
  return optionalDecoded(item, key, string, parentLabel);
}

function optionalBoolean(item: Record<string, unknown>, key: string): boolean | undefined {
  const value = item[key];
  return value === undefined ? undefined : boolean(value, key);
}

function optionalAgentStatus<Key extends string>(
  item: Record<string, unknown>,
  key: Key,
): Partial<Record<Key, AgentStatusUpdate['agent_status']>> {
  return optionalDecoded(item, key, agentStatus);
}

function optionalStringRecord<Key extends string>(
  item: Record<string, unknown>,
  key: Key,
  parentLabel?: string,
): Partial<Record<Key, Record<string, string>>> {
  return optionalDecoded(item, key, stringRecord, parentLabel);
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  const item = record(value, label);
  const decoded: Record<string, string> = {};
  for (const [key, entry] of Object.entries(item)) {
    decoded[key] = string(entry, `${label}.${key}`);
  }
  return decoded;
}

function fail(message: string): never {
  throw new Error(message);
}
