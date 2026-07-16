import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { hostDisplayName } from '../lib/hostProfiles';
import { colors } from '../theme';
import type { HostProfile } from '../types';

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
    <View style={styles.page}>
      <View style={styles.header}>
        <View style={styles.brandRow}>
          <Text style={styles.mark}>H/</Text>
          <View>
            <Text style={styles.brand}>HERDR REMOTE</Text>
            <Text style={styles.kicker}>SAVED SERVERS</Text>
          </View>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Add host" onPress={onAdd} style={styles.addButton}>
          <Text style={styles.addButtonText}>＋</Text>
        </Pressable>
      </View>

      <View style={styles.ruleRow}>
        <Text style={styles.ruleIndex}>{String(hosts.length).padStart(2, '0')}</Text>
        <Text style={styles.ruleText}>HERDR SERVERS ON THIS DEVICE</Text>
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      <ScrollView contentContainerStyle={styles.list}>
        {hosts.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyGlyph}>⌁</Text>
            <Text style={styles.emptyTitle}>NO SERVERS SAVED</Text>
            <Text style={styles.emptyCopy}>Add a Tailscale or SSH destination to start managing its Herdr session.</Text>
            <Pressable onPress={onAdd} style={styles.emptyButton}>
              <Text style={styles.emptyButtonText}>ADD FIRST HOST  →</Text>
            </Pressable>
          </View>
        ) : hosts.map((host, index) => {
          const connecting = connectingHostId === host.id;
          const active = activeHostId === host.id;
          const connected = connectedHostIds.includes(host.id);
          return (
            <View key={host.id} style={styles.hostRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Connect to ${hostDisplayName(host)}`}
                disabled={Boolean(connectingHostId)}
                onPress={() => onConnect(host)}
                style={({ pressed }) => [styles.hostMain, pressed && styles.hostPressed]}>
                <View style={styles.hostIndexBox}>
                  <Text style={styles.hostIndex}>{String(index + 1).padStart(2, '0')}</Text>
                  <View style={[styles.credentialDot, (host.rememberCredentials || active) && styles.credentialDotSaved]} />
                </View>
                <View style={styles.hostContent}>
                  <View style={styles.hostTitleRow}>
                    <Text numberOfLines={1} style={styles.hostName}>{hostDisplayName(host)}</Text>
                    <Text style={[styles.connectLabel, (active || connected) && styles.activeLabel]}>{connecting ? 'OPENING…' : active ? 'ACTIVE' : connected ? 'OPEN' : 'CONNECT  ›'}</Text>
                  </View>
                  <Text numberOfLines={1} style={styles.hostAddress}>
                    {host.username}@{host.host}{host.port !== '22' ? `:${host.port}` : ''}
                  </Text>
                  <View style={styles.hostMetaRow}>
                    <Text style={styles.hostMeta}>{host.authMode === 'key' ? 'SSH KEY' : 'PASSWORD'}</Text>
                    <Text style={styles.metaSeparator}>·</Text>
                    <Text style={[styles.hostMeta, host.rememberCredentials && styles.hostMetaSaved]}>
                      {host.rememberCredentials ? 'CREDENTIAL SAVED' : 'ASK ON CONNECT'}
                    </Text>
                    {host.lastConnectedAt && (
                      <>
                        <Text style={styles.metaSeparator}>·</Text>
                        <Text style={styles.hostMeta}>{formatLastUsed(host.lastConnectedAt)}</Text>
                      </>
                    )}
                  </View>
                </View>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Edit ${hostDisplayName(host)}`}
                onPress={() => onEdit(host)}
                style={styles.editButton}>
                <Text style={styles.editButtonText}>•••</Text>
              </Pressable>
            </View>
          );
        })}
      </ScrollView>

      <View style={styles.footer}>
        <View style={styles.footerDot} />
        <Text style={styles.footerText}>CREDENTIALS ARE ISOLATED PER HOST IN ANDROID KEYSTORE</Text>
      </View>
    </View>
  );
}

function formatLastUsed(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'USED BEFORE';
  const elapsed = Date.now() - date.getTime();
  if (elapsed < 60_000) return 'JUST NOW';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}M AGO`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}H AGO`;
  return `${Math.floor(elapsed / 86_400_000)}D AGO`;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.ink },
  header: { height: 88, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomColor: colors.line, borderBottomWidth: 1 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  mark: { color: colors.acid, fontFamily: 'monospace', fontSize: 34, fontWeight: '900' },
  brand: { color: colors.text, fontSize: 18, fontWeight: '900', letterSpacing: 1 },
  kicker: { color: colors.muted, fontFamily: 'monospace', fontSize: 8, letterSpacing: 1.5, marginTop: 2 },
  addButton: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.acid, marginRight: 52 },
  addButtonText: { color: colors.ink, fontSize: 27, lineHeight: 29, fontWeight: '400' },
  ruleRow: { paddingHorizontal: 18, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.panel },
  ruleIndex: { color: colors.acid, fontFamily: 'monospace', fontSize: 10, fontWeight: '900' },
  ruleText: { color: colors.muted, fontFamily: 'monospace', fontSize: 9, letterSpacing: 1.2 },
  error: { color: colors.blocked, fontFamily: 'monospace', fontSize: 11, lineHeight: 16, paddingHorizontal: 18, paddingVertical: 12, borderBottomColor: colors.line, borderBottomWidth: 1 },
  list: { flexGrow: 1 },
  hostRow: { minHeight: 92, flexDirection: 'row', borderBottomColor: colors.line, borderBottomWidth: 1 },
  hostMain: { flex: 1, flexDirection: 'row', paddingLeft: 18 },
  hostPressed: { backgroundColor: colors.panelRaised },
  hostIndexBox: { width: 42, paddingTop: 19 },
  hostIndex: { color: colors.muted, fontFamily: 'monospace', fontSize: 10 },
  credentialDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.muted, marginTop: 10 },
  credentialDotSaved: { backgroundColor: colors.acid },
  hostContent: { flex: 1, paddingVertical: 16, minWidth: 0 },
  hostTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  hostName: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '800' },
  connectLabel: { color: colors.acid, fontFamily: 'monospace', fontSize: 8, letterSpacing: 0.7 },
  activeLabel: { color: colors.working },
  hostAddress: { color: colors.muted, fontFamily: 'monospace', fontSize: 10, marginTop: 5 },
  hostMetaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginTop: 7, gap: 5 },
  hostMeta: { color: colors.muted, fontFamily: 'monospace', fontSize: 7, letterSpacing: 0.5 },
  hostMetaSaved: { color: colors.acid },
  metaSeparator: { color: colors.line, fontFamily: 'monospace', fontSize: 8 },
  editButton: { width: 54, alignItems: 'center', justifyContent: 'center' },
  editButtonText: { color: colors.muted, fontFamily: 'monospace', fontSize: 12, letterSpacing: 1 },
  empty: { flex: 1, minHeight: 440, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 34 },
  emptyGlyph: { color: colors.acid, fontFamily: 'monospace', fontSize: 44 },
  emptyTitle: { color: colors.text, fontFamily: 'monospace', fontSize: 15, fontWeight: '900', letterSpacing: 1, marginTop: 14 },
  emptyCopy: { color: colors.muted, textAlign: 'center', fontSize: 12, lineHeight: 19, marginTop: 10, maxWidth: 300 },
  emptyButton: { backgroundColor: colors.acid, paddingHorizontal: 18, paddingVertical: 13, marginTop: 22 },
  emptyButtonText: { color: colors.ink, fontFamily: 'monospace', fontSize: 10, fontWeight: '900' },
  footer: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, borderTopColor: colors.line, borderTopWidth: 1 },
  footerDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.acid },
  footerText: { flex: 1, color: colors.muted, fontFamily: 'monospace', fontSize: 7, letterSpacing: 0.5 },
});
