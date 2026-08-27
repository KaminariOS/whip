import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  REMOTE_GIT_PREFERENCES_KEY,
  REMOTE_GIT_TREE_PREFERENCES_KEY,
  loadRemoteGitCollapsedPaths,
  loadRemoteGitMode,
  saveRemoteGitCollapsedPaths,
  saveRemoteGitMode,
} from '../src/services/remoteGitPreferences';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn(),
  },
}));

const getItem = AsyncStorage.getItem as jest.MockedFunction<
  typeof AsyncStorage.getItem
>;
const setItem = AsyncStorage.setItem as jest.MockedFunction<
  typeof AsyncStorage.setItem
>;

beforeEach(() => {
  jest.clearAllMocks();
});

it('loads the mode only for the matching host and canonical repository root', async () => {
  getItem.mockResolvedValue(
    JSON.stringify([
      { hostId: 'host-a', root: '/repo', updatedAt: 2 },
      { hostId: 'host-b', root: '/other', updatedAt: 1 },
    ]),
  );

  await expect(loadRemoteGitMode('host-a', '/repo')).resolves.toBe(true);
  await expect(loadRemoteGitMode('host-a', '/other')).resolves.toBe(false);
  expect(getItem).toHaveBeenCalledWith(REMOTE_GIT_PREFERENCES_KEY);
});

it('diagnoses malformed persisted data instead of treating it as disabled', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  getItem.mockResolvedValue('{broken');

  await expect(loadRemoteGitMode('host-a', '/repo')).rejects.toBeInstanceOf(SyntaxError);
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('storage-parse-failed'));
  consoleError.mockRestore();
});

it('persists enabled repositories and removes disabled repositories', async () => {
  jest.spyOn(Date, 'now').mockReturnValue(1234);
  getItem
    .mockResolvedValueOnce(
      JSON.stringify([{ hostId: 'host-b', root: '/other', updatedAt: 2 }]),
    )
    .mockResolvedValueOnce(
      JSON.stringify([
        { hostId: 'host-a', root: '/repo', updatedAt: 3 },
        { hostId: 'host-b', root: '/other', updatedAt: 2 },
      ]),
    );

  await saveRemoteGitMode('host-a', '/repo', true);
  await saveRemoteGitMode('host-a', '/repo', false);

  expect(setItem).toHaveBeenNthCalledWith(
    1,
    REMOTE_GIT_PREFERENCES_KEY,
    JSON.stringify([
      { hostId: 'host-a', root: '/repo', updatedAt: 1234 },
      { hostId: 'host-b', root: '/other', updatedAt: 2 },
    ]),
  );
  expect(setItem).toHaveBeenNthCalledWith(
    2,
    REMOTE_GIT_PREFERENCES_KEY,
    JSON.stringify([{ hostId: 'host-b', root: '/other', updatedAt: 2 }]),
  );
  jest.restoreAllMocks();
});

it('persists collapsed directories per host and repository', async () => {
  getItem
    .mockResolvedValueOnce(
      JSON.stringify([
        {
          hostId: 'host-a',
          root: '/repo',
          collapsedPaths: ['src', 'packages/app'],
          updatedAt: 2,
        },
      ]),
    )
    .mockResolvedValueOnce('[]');

  await expect(loadRemoteGitCollapsedPaths('host-a', '/repo')).resolves.toEqual(
    ['src', 'packages/app'],
  );
  await saveRemoteGitCollapsedPaths('host-a', '/repo', ['src', 'src']);

  expect(getItem).toHaveBeenNthCalledWith(1, REMOTE_GIT_TREE_PREFERENCES_KEY);
  expect(setItem).toHaveBeenCalledWith(
    REMOTE_GIT_TREE_PREFERENCES_KEY,
    expect.stringContaining('"collapsedPaths":["src"]'),
  );
});

it('does not overwrite repository preferences after a transient read failure', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  const readError = new Error('AsyncStorage unavailable');
  getItem.mockRejectedValueOnce(readError);

  await expect(saveRemoteGitMode('host-a', '/repo', true)).rejects.toBe(readError);

  expect(setItem).not.toHaveBeenCalled();
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('storage-read-failed'));
  consoleError.mockRestore();
});

it('does not overwrite tree preferences after corrupted state is read', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  getItem.mockResolvedValueOnce('{broken');

  await expect(saveRemoteGitCollapsedPaths('host-a', '/repo', ['src']))
    .rejects.toBeInstanceOf(SyntaxError);

  expect(setItem).not.toHaveBeenCalled();
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('storage-parse-failed'));
  consoleError.mockRestore();
});
