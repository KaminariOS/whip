import {
  CommandLaunchPartialFailure,
  createWorkspaceAndSelect,
  launchTabAndOpenCreatedTab,
  type TabCreationResult,
} from '../src/lib/herdrCreationFlows';
import { runWithInFlightGuard } from '../src/lib/inFlightSubmission';
import type { WorkspaceInfo } from '../src/types';

jest.mock('react-native-whip-ssh', () => ({
  __esModule: true,
  createHostRuntime: jest.fn(),
}));

const workspace = {
  workspace_id: 'workspace-new',
  number: 2,
  label: 'New space',
  focused: true,
  pane_count: 1,
  tab_count: 1,
  active_tab_id: 'tab-new',
  agent_status: 'idle',
} as WorkspaceInfo;

const created = {
  type: 'tab_created',
  tab: {
    tab_id: 'tab-new',
    workspace_id: 'workspace-new',
    number: 1,
    label: 'Checks',
    focused: true,
    pane_count: 1,
    agent_status: 'idle',
  },
  root_pane: {
    pane_id: 'pane-new',
    terminal_id: 'terminal-new',
    workspace_id: 'workspace-new',
    tab_id: 'tab-new',
    focused: true,
    agent_status: 'idle',
    revision: 0,
  },
} as TabCreationResult;

test('workspace creation selects and filters by the returned workspace id', async () => {
  const filter = jest.fn();
  const select = jest.fn();

  await expect(createWorkspaceAndSelect(async () => workspace, filter, select)).resolves.toBe(workspace);

  expect(filter).toHaveBeenCalledWith('workspace-new');
  expect(select).toHaveBeenCalledWith('workspace-new');
});

test('semantic tab launch opens the returned pane without requesting a snapshot', async () => {
  const client = {
    createTabWithLaunch: jest.fn(async () => created),
    snapshot: jest.fn(),
  };
  const open = jest.fn();

  await expect(launchTabAndOpenCreatedTab(
    client,
    'workspace-new',
    'Checks',
    { type: 'command', command: 'npm test' },
    open,
  )).resolves.toBe(created);

  expect(open).toHaveBeenCalledWith(created);
  expect(client.snapshot).not.toHaveBeenCalled();
});

test('partial launch failure still opens the created pane and remains an error', async () => {
  const failure = Object.assign(new Error('input failed'), {
    code: 'TAB_LAUNCH_FAILED' as const,
    created,
    launchType: 'command' as const,
  });
  const client = { createTabWithLaunch: jest.fn(async () => { throw failure; }) };
  const open = jest.fn();

  await expect(launchTabAndOpenCreatedTab(
    client,
    'workspace-new',
    'Checks',
    { type: 'command', command: 'npm test' },
    open,
  )).rejects.toBeInstanceOf(CommandLaunchPartialFailure);

  expect(open).toHaveBeenCalledWith(created);
});

test('a synchronous in-flight guard rejects duplicate save presses', async () => {
  const guard = { current: false };
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const create = jest.fn(() => pending);

  const first = runWithInFlightGuard(guard, create);
  const duplicate = runWithInFlightGuard(guard, create);

  await expect(duplicate).resolves.toBe(false);
  expect(create).toHaveBeenCalledTimes(1);
  finish();
  await expect(first).resolves.toBe(true);
});
