import { AlertCircle, Ellipsis, LockKeyhole, Plus, Server } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { hostDisplayName } from '@/src/lib/hostProfiles';
import type { CredentialRecoveryStatus } from '@/src/services/credentialVault';
import type { HostProfile } from '@/src/types';
import { hapticPress, IconButton, ScreenHeader, StatusBadge, WhipMark } from './app-ui';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

interface Props {
  hosts: HostProfile[];
  connectingHostId: string | null;
  error: string | null;
  activeHostId?: string | null;
  connectedHostIds?: string[];
  latencyMsByHostId?: Record<string, number | null | undefined>;
  credentialRecovery: CredentialRecoveryStatus;
  credentialRecoveryBusy: boolean;
  onAdd: () => void;
  onConnect: (host: HostProfile) => void;
  onEdit: (host: HostProfile) => void;
  onUnlockCredentials: () => Promise<boolean>;
}

export function HostsScreen({ hosts, connectingHostId, error, activeHostId, connectedHostIds = [], latencyMsByHostId = {}, credentialRecovery, credentialRecoveryBusy, onAdd, onConnect, onEdit, onUnlockCredentials }: Props) {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title="Herdr"
        subtitle={t('hosts.subtitle')}
        left={<WhipMark size={40} />}
        right={<IconButton icon={Plus} accessibilityLabel={t('hosts.add')} onPress={onAdd} />}
      />

      {error ? (
        <View className="mx-4 mt-4 flex-row items-start gap-2 rounded-md bg-destructive/10 p-3">
          <Icon as={AlertCircle} className="text-destructive" size={18} />
          <Text className="flex-1 text-[13px] leading-[18px] text-destructive">{error}</Text>
        </View>
      ) : null}

      {credentialRecovery.state === 'locked' ? (
        <View className="mx-4 mt-4 flex-row items-center gap-3 rounded-lg border border-border bg-card p-3.5">
          <View className="size-10 items-center justify-center rounded-full bg-primary/10"><Icon as={LockKeyhole} className="text-primary" size={19} /></View>
          <View className="min-w-0 flex-1"><Text className="text-sm font-semibold">{t('hosts.recoveryLocked')}</Text><Text className="mt-0.5 text-xs leading-[17px] text-muted-foreground">{t('hosts.recoveryCopy', { count: credentialRecovery.count })}</Text></View>
          <Button className="rounded-full px-3.5" size="sm" disabled={credentialRecoveryBusy} onPress={hapticPress(async () => { await onUnlockCredentials(); })}><Text>{credentialRecoveryBusy ? t('hosts.unlocking') : t('hosts.unlock')}</Text></Button>
        </View>
      ) : null}

      {credentialRecovery.state === 'unavailable' ? (
        <View className="mx-4 mt-4 flex-row items-start gap-2 rounded-md bg-destructive/10 p-3">
          <Icon as={AlertCircle} className="text-destructive" size={18} />
          <Text className="flex-1 text-[13px] leading-[18px] text-destructive">{t('hosts.recoveryUnavailable')}</Text>
        </View>
      ) : null}

      <ScrollView className="flex-1">
        <View className="flex-grow p-4 pb-6">
          {hosts.length === 0 ? (
            <View className="min-h-[440px] flex-1 items-center justify-center px-7">
              <View className="size-[72px] items-center justify-center rounded-full bg-muted"><Icon as={Server} size={30} /></View>
              <Text className="mt-5 text-[22px] font-semibold leading-7">{t('hosts.emptyTitle')}</Text>
              <Text className="mt-2 max-w-[310px] text-center text-[15px] leading-[22px] text-muted-foreground">{t('hosts.emptyCopy')}</Text>
              <Button className="mt-6 rounded-full" onPress={hapticPress(onAdd)}><Icon as={Plus} className="text-primary-foreground" size={17} /><Text>{t('hosts.addFirst')}</Text></Button>
            </View>
          ) : (
            <>
              <Text className="mb-3 px-1 text-sm font-semibold text-muted-foreground">{t('hosts.count', { count: hosts.length })}</Text>
              <View className="gap-3">
                {hosts.map(host => {
                  const connecting = connectingHostId === host.id;
                  const active = activeHostId === host.id;
                  const connected = connectedHostIds.includes(host.id);
                  const state = connecting ? 'working' : active || connected ? 'done' : 'idle';
                  const label = connecting ? t('hosts.opening') : active ? t('hosts.active') : connected ? t('hosts.open') : t('common.connect');
                  const displayName = hostDisplayName(host);
                  const latencyMs = latencyMsByHostId[host.id];
                  return (
                    <View className="min-h-[88px] flex-row items-center rounded-lg border border-border bg-card pr-2" key={host.id}>
                      <Button
                        accessibilityLabel={t('hosts.connectTo', { host: displayName })}
                        className="h-auto min-h-[88px] min-w-0 flex-1 self-stretch justify-start gap-3 rounded-none px-3 py-3 sm:h-auto"
                        disabled={Boolean(connectingHostId)}
                        size="content"
                        variant="ghost"
                        onPress={hapticPress(() => onConnect(host))}>
                        <View className="size-11 items-center justify-center rounded-full bg-accent"><Text className="text-[17px] font-semibold">{displayName.slice(0, 1).toUpperCase()}</Text></View>
                        <View className="min-w-0 flex-1">
                          <View className="flex-row items-center gap-2"><Text className="flex-1 text-base font-semibold" numberOfLines={1}>{displayName}</Text><StatusBadge status={state} label={label} /></View>
                          <View className="mt-1 flex-row items-center gap-2">
                            <Text className="min-w-0 flex-1 text-[13px] leading-[18px] text-muted-foreground" numberOfLines={1}>{host.username}@{host.host}{host.port !== '22' ? `:${host.port}` : ''}</Text>
                            <Text accessibilityLabel={latencyMs == null ? t('hosts.latencyUnavailable') : t('hosts.latency', { value: latencyMs })} className="text-[11px] leading-[18px] text-muted-foreground/70">{latencyMs == null ? '— ms' : `${latencyMs} ms`}</Text>
                          </View>
                          <Text className="mt-0.5 text-[11px] leading-[15px] text-muted-foreground/70" numberOfLines={1}>{host.authMode === 'key' ? t('hosts.sshKey') : t('hosts.password')} · {host.rememberCredentials ? t('hosts.credentialSaved') : t('hosts.askOnConnect')}{host.lastConnectedAt ? ` · ${formatLastUsed(host.lastConnectedAt, t)}` : ''}</Text>
                        </View>
                      </Button>
                      <IconButton icon={Ellipsis} accessibilityLabel={t('hosts.edit', { host: displayName })} onPress={() => onEdit(host)} />
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
        <Text className="flex-1 text-[11px] leading-[15px] text-muted-foreground">{t('hosts.securityCopy')}</Text>
      </View>
    </View>
  );
}

function formatLastUsed(value: string, t: TFunction): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t('hosts.usedBefore');
  const elapsed = Date.now() - date.getTime();
  if (elapsed < 60_000) return t('hosts.justNow');
  if (elapsed < 3_600_000) return t('hosts.minutesAgo', { count: Math.floor(elapsed / 60_000) });
  if (elapsed < 86_400_000) return t('hosts.hoursAgo', { count: Math.floor(elapsed / 3_600_000) });
  return t('hosts.daysAgo', { count: Math.floor(elapsed / 86_400_000) });
}
