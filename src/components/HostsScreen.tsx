import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { hostDisplayName } from '../lib/hostProfiles';
import { radii, spacing, useTheme } from '../theme';
import type { HostProfile } from '../types';
import { Button, IconButton, ScreenHeader, SectionLabel, StatusBadge } from './ui';

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
  const { colors } = useTheme();
  return (
    <View style={[styles.page, { backgroundColor: colors.canvas }]}>
      <ScreenHeader
        title="Herdr"
        subtitle="Remote servers"
        left={<View style={[styles.brandMark, { backgroundColor: colors.primary }]}><Text style={[styles.brandText, { color: colors.onPrimary }]}>H</Text></View>}
        right={<IconButton icon="add" label="Add host" onPress={onAdd} />}
      />

      {error && (
        <View style={[styles.error, { backgroundColor: `${colors.error}14` }]}>
          <Ionicons name="alert-circle-outline" size={18} color={colors.error} />
          <Text style={[styles.errorText, { color: colors.error }]}>{error}</Text>
        </View>
      )}

      <ScrollView contentContainerStyle={styles.list}>
        {hosts.length === 0 ? (
          <View style={styles.empty}>
            <View style={[styles.emptyIcon, { backgroundColor: colors.surface }]}>
              <Ionicons name="server-outline" size={30} color={colors.text} />
            </View>
            <Text style={[styles.emptyTitle, { color: colors.text }]}>No servers yet</Text>
            <Text style={[styles.emptyCopy, { color: colors.textSecondary }]}>Add a Tailscale or SSH destination to manage its Herdr session.</Text>
            <Button label="Add your first host" icon="add" onPress={onAdd} style={styles.emptyButton} />
          </View>
        ) : (
          <>
            <SectionLabel>{hosts.length} {hosts.length === 1 ? 'server' : 'servers'} on this device</SectionLabel>
            <View style={[styles.group, { backgroundColor: colors.surface, borderColor: colors.divider }]}>
              {hosts.map((host, index) => {
                const connecting = connectingHostId === host.id;
                const active = activeHostId === host.id;
                const connected = connectedHostIds.includes(host.id);
                const state = connecting ? 'working' : active || connected ? 'done' : 'idle';
                const label = connecting ? 'Opening' : active ? 'Active' : connected ? 'Open' : 'Connect';
                const displayName = hostDisplayName(host);
                return (
                  <View key={host.id} style={[styles.hostRow, index > 0 && { borderTopColor: colors.divider, borderTopWidth: StyleSheet.hairlineWidth }]}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Connect to ${displayName}`}
                      disabled={Boolean(connectingHostId)}
                      onPress={() => onConnect(host)}
                      style={({ pressed }) => [styles.hostMain, pressed && { opacity: 0.65 }]}>
                      <View style={[styles.avatar, { backgroundColor: colors.surfaceRaised }]}>
                        <Text style={[styles.avatarText, { color: colors.text }]}>{displayName.slice(0, 1).toUpperCase()}</Text>
                      </View>
                      <View style={styles.hostContent}>
                        <View style={styles.hostTitleRow}>
                          <Text numberOfLines={1} style={[styles.hostName, { color: colors.text }]}>{displayName}</Text>
                          <StatusBadge status={state} label={label} />
                        </View>
                        <Text numberOfLines={1} style={[styles.hostAddress, { color: colors.textSecondary }]}>
                          {host.username}@{host.host}{host.port !== '22' ? `:${host.port}` : ''}
                        </Text>
                        <Text numberOfLines={1} style={[styles.hostMeta, { color: colors.textTertiary }]}>
                          {host.authMode === 'key' ? 'SSH key' : 'Password'} · {host.rememberCredentials ? 'Credential saved' : 'Ask on connect'}{host.lastConnectedAt ? ` · ${formatLastUsed(host.lastConnectedAt)}` : ''}
                        </Text>
                      </View>
                    </Pressable>
                    <IconButton icon="ellipsis-horizontal" label={`Edit ${displayName}`} onPress={() => onEdit(host)} />
                  </View>
                );
              })}
            </View>
          </>
        )}
      </ScrollView>

      <View style={[styles.footer, { borderTopColor: colors.divider }]}>
        <Ionicons name="lock-closed-outline" size={14} color={colors.textSecondary} />
        <Text style={[styles.footerText, { color: colors.textSecondary }]}>Credentials are isolated per host in Android Keystore.</Text>
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

const styles = StyleSheet.create({
  page: { flex: 1 },
  brandMark: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  brandText: { fontSize: 17, fontWeight: '700' },
  error: { margin: spacing.lg, marginBottom: 0, borderRadius: radii.md, padding: 12, flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  errorText: { flex: 1, fontSize: 13, lineHeight: 18 },
  list: { flexGrow: 1, padding: spacing.lg, paddingBottom: spacing.xl },
  group: { borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  hostRow: { minHeight: 88, flexDirection: 'row', alignItems: 'center', paddingRight: 8 },
  hostMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', padding: 12, gap: 12 },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 17, fontWeight: '600' },
  hostContent: { flex: 1, minWidth: 0 },
  hostTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  hostName: { flex: 1, fontSize: 16, lineHeight: 21, fontWeight: '600' },
  hostAddress: { fontSize: 13, lineHeight: 18, marginTop: 3 },
  hostMeta: { fontSize: 11, lineHeight: 15, marginTop: 3 },
  empty: { flex: 1, minHeight: 440, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },
  emptyIcon: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: 22, lineHeight: 28, fontWeight: '600', marginTop: 20 },
  emptyCopy: { textAlign: 'center', fontSize: 15, lineHeight: 22, marginTop: 8, maxWidth: 310 },
  emptyButton: { marginTop: 24 },
  footer: { minHeight: 44, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18 },
  footerText: { flex: 1, fontSize: 11, lineHeight: 15 },
});
