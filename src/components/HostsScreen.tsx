import { AlertCircle, LockKeyhole, Plus, Server } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';

import { hostDisplayName } from '@/src/lib/hostProfiles';
import type { HostProfile } from '@/src/types';
import { hapticPress, IconButton, ScreenHeader, StatusBadge } from './app-ui';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

interface Props {
  hosts: HostProfile[];
  connectingHostId: string | null;
  error: string | null;
  activeHostId?: string | null;
  connectedHostIds?: string[];
  onAdd: () => void;
  onConnect: (host: HostProfile) => void;
  onEdit: (host: HostProfile) => void;
}

export function HostsScreen({ hosts, connectingHostId, error, activeHostId, connectedHostIds = [], onAdd, onConnect, onEdit }: Props) {
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title="Herdr"
        subtitle="Remote servers"
        left={<View className="size-10 items-center justify-center rounded-full bg-primary"><Text className="text-[17px] font-bold text-primary-foreground">H</Text></View>}
        right={<IconButton icon="add" accessibilityLabel="Add host" onPress={onAdd} />}
      />

      {error ? (
        <View className="mx-4 mt-4 flex-row items-start gap-2 rounded-md bg-destructive/10 p-3">
          <Icon as={AlertCircle} className="text-destructive" size={18} />
          <Text className="flex-1 text-[13px] leading-[18px] text-destructive">{error}</Text>
        </View>
      ) : null}

      <ScrollView className="flex-1">
        <View className="flex-grow p-4 pb-6">
          {hosts.length === 0 ? (
            <View className="min-h-[440px] flex-1 items-center justify-center px-7">
              <View className="size-[72px] items-center justify-center rounded-full bg-muted"><Icon as={Server} size={30} /></View>
              <Text className="mt-5 text-[22px] font-semibold leading-7">No servers yet</Text>
              <Text className="mt-2 max-w-[310px] text-center text-[15px] leading-[22px] text-muted-foreground">Add a Tailscale or SSH destination to manage its Herdr session.</Text>
              <Button className="mt-6 rounded-full" onPress={hapticPress(onAdd)}><Icon as={Plus} className="text-primary-foreground" size={17} /><Text>Add your first host</Text></Button>
            </View>
          ) : (
            <>
              <Text className="mb-3 px-1 text-sm font-semibold text-muted-foreground">{hosts.length} {hosts.length === 1 ? 'server' : 'servers'} on this device</Text>
              <View className="overflow-hidden rounded-lg border border-border bg-card">
                {hosts.map((host, index) => {
                  const connecting = connectingHostId === host.id;
                  const active = activeHostId === host.id;
                  const connected = connectedHostIds.includes(host.id);
                  const state = connecting ? 'working' : active || connected ? 'done' : 'idle';
                  const label = connecting ? 'Opening' : active ? 'Active' : connected ? 'Open' : 'Connect';
                  const displayName = hostDisplayName(host);
                  return (
                    <View className={index > 0 ? 'min-h-[88px] flex-row items-center border-t border-border pr-2' : 'min-h-[88px] flex-row items-center pr-2'} key={host.id}>
                      <Button
                        accessibilityLabel={`Connect to ${displayName}`}
                        className="h-auto min-w-0 flex-1 justify-start gap-3 rounded-none px-3 py-3"
                        disabled={Boolean(connectingHostId)}
                        variant="ghost"
                        onPress={hapticPress(() => onConnect(host))}>
                        <View className="size-11 items-center justify-center rounded-full bg-accent"><Text className="text-[17px] font-semibold">{displayName.slice(0, 1).toUpperCase()}</Text></View>
                        <View className="min-w-0 flex-1">
                          <View className="flex-row items-center gap-2"><Text className="flex-1 text-base font-semibold" numberOfLines={1}>{displayName}</Text><StatusBadge status={state} label={label} /></View>
                          <Text className="mt-1 text-[13px] leading-[18px] text-muted-foreground" numberOfLines={1}>{host.username}@{host.host}{host.port !== '22' ? `:${host.port}` : ''}</Text>
                          <Text className="mt-0.5 text-[11px] leading-[15px] text-muted-foreground/70" numberOfLines={1}>{host.authMode === 'key' ? 'SSH key' : 'Password'} · {host.rememberCredentials ? 'Credential saved' : 'Ask on connect'}{host.lastConnectedAt ? ` · ${formatLastUsed(host.lastConnectedAt)}` : ''}</Text>
                        </View>
                      </Button>
                      <IconButton icon="ellipsis-horizontal" accessibilityLabel={`Edit ${displayName}`} onPress={() => onEdit(host)} />
                    </View>
                  );
                })}
              </View>
            </>
          )}
        </View>
      </ScrollView>

      <View className="min-h-11 flex-row items-center gap-2 border-t border-border px-[18px]">
        <Icon as={LockKeyhole} className="text-muted-foreground" size={14} />
        <Text className="flex-1 text-[11px] leading-[15px] text-muted-foreground">Credentials are isolated per host in Android Keystore.</Text>
      </View>
    </View>
  );
}

function formatLastUsed(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Used before';
  const elapsed = Date.now() - date.getTime();
  if (elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
}
