jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn() },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadPersistedLiveHosts, savePersistedLiveHosts } from '../src/services/persistedLiveHosts';

const mockGetItem = jest.mocked(AsyncStorage.getItem);
const mockSetItem = jest.mocked(AsyncStorage.setItem);

beforeEach(() => {
  mockGetItem.mockReset();
  mockSetItem.mockReset();
});

test('loads only valid unique host ids and repairs the active id', async () => {
  mockGetItem.mockResolvedValue(JSON.stringify({
    hostIds: ['savior', '', 'savior', 4, 'backup'],
    activeHostId: 'missing',
  }));
  await expect(loadPersistedLiveHosts()).resolves.toEqual({
    hostIds: ['savior', 'backup'],
    activeHostId: 'savior',
  });
});

test('persists the live host rail', async () => {
  const state = { hostIds: ['savior'], activeHostId: 'savior' };
  await savePersistedLiveHosts(state);
  expect(mockSetItem).toHaveBeenCalledWith('herdr.live.hosts.v1', JSON.stringify(state));
});
