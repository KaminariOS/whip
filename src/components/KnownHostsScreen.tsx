import { ChevronLeft, Fingerprint, ShieldCheck, Trash2 } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { deleteKnownHost } from '@/src/services/knownHosts';
import type { KnownHost } from '@/src/types';
import { hapticPress, IconButton, ScreenHeader } from './app-ui';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

interface Props {
  initialHosts: KnownHost[];
  onClose: () => void;
  onChanged: (hosts: KnownHost[]) => void;
}

export function KnownHostsScreen({ initialHosts, onClose, onChanged }: Props) {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState(initialHosts);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setHosts(initialHosts); }, [initialHosts]);

  const updateHosts = (next: KnownHost[]) => {
    setHosts(next);
    onChanged(next);
  };

  const confirmDelete = (host: KnownHost) => {
    Alert.alert(
      t('knownHosts.deleteTitle', { host: displayHost(host) }),
      t('knownHosts.deleteCopy'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.remove'),
          style: 'destructive',
          onPress: () => {
            setBusy(true);
            deleteKnownHost(hosts, host.id)
              .then(updateHosts)
              .catch(error => Alert.alert(t('knownHosts.deleteError'), String(error)))
              .finally(() => setBusy(false));
          },
        },
      ],
    );
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('knownHosts.title')}
        subtitle={t('knownHosts.count', { count: hosts.length })}
        left={<IconButton icon={ChevronLeft} accessibilityLabel={t('connection.back')} onPress={onClose} />}
      />
      <ScrollView className="flex-1">
        <View className="p-4 pb-10">
          <View className="mb-5 flex-row items-start gap-3 rounded-lg bg-muted p-4">
            <Icon as={ShieldCheck} className="text-primary" size={21} />
            <View className="flex-1">
              <Text className="text-sm font-semibold">{t('knownHosts.verified')}</Text>
              <Text className="mt-1 text-xs leading-[18px] text-muted-foreground">{t('knownHosts.verifiedCopy')}</Text>
            </View>
          </View>

          {hosts.length === 0 ? (
            <View className="min-h-[320px] items-center justify-center px-7">
              <View className="size-16 items-center justify-center rounded-full bg-muted">
                <Icon as={Fingerprint} size={27} />
              </View>
              <Text className="mt-4 text-lg font-semibold">{t('knownHosts.emptyTitle')}</Text>
              <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">{t('knownHosts.emptyCopy')}</Text>
            </View>
          ) : (
            <View className="overflow-hidden rounded-lg border border-border bg-card">
              {hosts.map((host, index) => (
                <View
                  key={host.id}
                  className={index ? 'min-h-[82px] flex-row items-center border-t border-border p-3.5' : 'min-h-[82px] flex-row items-center p-3.5'}
                >
                  <View className="size-10 items-center justify-center rounded-full bg-primary/10">
                    <Icon as={Fingerprint} className="text-primary" size={18} />
                  </View>
                  <View className="ml-3 min-w-0 flex-1">
                    <Text className="text-[15px] font-semibold" numberOfLines={1}>{displayHost(host)}</Text>
                    <Text className="mt-0.5 font-mono text-[11px] text-muted-foreground" ellipsizeMode="middle" numberOfLines={1}>{host.fingerprint}</Text>
                    <Text className="mt-0.5 text-[11px] text-muted-foreground">{host.keyType}</Text>
                  </View>
                  <IconButton
                    icon={Trash2}
                    accessibilityLabel={t('knownHosts.remove', { host: displayHost(host) })}
                    className="ml-2 size-10"
                    disabled={busy}
                    onPress={hapticPress(() => confirmDelete(host))}
                  />
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function displayHost(host: Pick<KnownHost, 'host' | 'port'>): string {
  return host.port === 22 ? host.host : `[${host.host}]:${host.port}`;
}
