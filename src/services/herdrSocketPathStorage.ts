import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  hydrateHerdrSocketPathCache,
  setHerdrSocketPathCacheChangeListener,
} from './herdrSocketPathCache';

export const HERDR_SOCKET_PATH_CACHE_KEY = 'herdr.api-socket-paths.v1';

let persistenceQueue: Promise<void> = Promise.resolve();

setHerdrSocketPathCacheChangeListener(serialized => {
  persistenceQueue = persistenceQueue
    .then(() => AsyncStorage.setItem(HERDR_SOCKET_PATH_CACHE_KEY, serialized))
    .catch(() => undefined);
});

export { hydrateHerdrSocketPathCache } from './herdrSocketPathCache';

export async function loadHerdrSocketPathCache(): Promise<void> {
  hydrateHerdrSocketPathCache(await AsyncStorage.getItem(HERDR_SOCKET_PATH_CACHE_KEY));
}

export async function flushHerdrSocketPathCacheWrites(): Promise<void> {
  await persistenceQueue;
}
