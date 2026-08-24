jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { multiGet: jest.fn() },
}));
jest.mock('../src/services/terminalBackground', () => ({}));
jest.mock('../src/services/appBackground', () => ({}));
jest.mock('react-native-whip-ssh', () => ({
  __esModule: true,
  default: { setKnownHosts: jest.fn() },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  STARTUP_STORAGE_KEYS,
  readStartupStorage,
} from '../src/services/startupStorage';

test('reads every startup value through one AsyncStorage bridge call', async () => {
  jest.mocked(AsyncStorage.multiGet).mockResolvedValueOnce(
    STARTUP_STORAGE_KEYS.map(key => [key, `value:${key}`]),
  );

  const snapshot = await readStartupStorage();

  expect(AsyncStorage.multiGet).toHaveBeenCalledTimes(1);
  expect(AsyncStorage.multiGet).toHaveBeenCalledWith([...STARTUP_STORAGE_KEYS]);
  expect(snapshot.hosts).toBe('value:herdr.hosts.v2');
  expect(snapshot.preferences).toBe('value:herdr.device.preferences.v3');
  expect(snapshot.knownHosts).toBe('value:herdr.known-hosts.v1');
  expect(snapshot.liveHosts).toBe('value:herdr.live.hosts.v1');
  expect(snapshot.terminalHistory).toBe('value:herdr.terminal.history.v1');
});
