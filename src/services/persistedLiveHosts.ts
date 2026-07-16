import AsyncStorage from '@react-native-async-storage/async-storage';

const LIVE_HOSTS_KEY = 'herdr.live.hosts.v1';

export interface PersistedLiveHosts {
  hostIds: string[];
  activeHostId: string | null;
}

export async function loadPersistedLiveHosts(): Promise<PersistedLiveHosts> {
  const value = await AsyncStorage.getItem(LIVE_HOSTS_KEY);
  if (!value) return { hostIds: [], activeHostId: null };
  try {
    const parsed = JSON.parse(value) as Partial<PersistedLiveHosts>;
    const hostIds = Array.isArray(parsed.hostIds)
      ? [...new Set(parsed.hostIds.filter((id): id is string => typeof id === 'string' && Boolean(id)))]
      : [];
    return {
      hostIds,
      activeHostId: typeof parsed.activeHostId === 'string' && hostIds.includes(parsed.activeHostId)
        ? parsed.activeHostId
        : hostIds[0] || null,
    };
  } catch {
    return { hostIds: [], activeHostId: null };
  }
}

export async function savePersistedLiveHosts(state: PersistedLiveHosts): Promise<void> {
  await AsyncStorage.setItem(LIVE_HOSTS_KEY, JSON.stringify(state));
}
