import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { HerdrClient } from '../services/HerdrClient';
import type { TerminalSessionsState } from '../terminalSessions';
import type { TerminalSessionStatus } from '../terminalSessions';
import type { TerminalPreferences } from '../services/devicePreferences';
import { colors, statusColor } from '../theme';
import type { HerdrSnapshot, PaneInfo, TabInfo, WorkspaceInfo } from '../types';
import { TerminalScreen } from './TerminalScreen';

interface Props {
  visible: boolean;
  snapshot: HerdrSnapshot;
  client: HerdrClient;
  terminalState: TerminalSessionsState;
  onRefresh: () => Promise<void>;
  onOpenPane: (pane: PaneInfo) => void;
  onActivateTerminal: (pane: PaneInfo) => void;
  onCloseTerminal: (terminalId: string) => void;
  onTerminalStatus: (terminalId: string, status: TerminalSessionStatus, error?: string, reconnectAttempt?: number) => void;
  terminalPreferences: TerminalPreferences;
  onExit: () => void;
  showExit?: boolean;
}

type EditorMode = 'workspace' | 'tab' | 'rename-workspace' | 'rename-tab';
type PendingFocus = {
  kind: 'workspace' | 'tab';
  mode: 'create' | 'close';
  previousId: string | null;
};

export function SessionScreen({
  visible,
  snapshot,
  client,
  terminalState,
  onRefresh,
  onOpenPane,
  onActivateTerminal,
  onCloseTerminal,
  onTerminalStatus,
  terminalPreferences,
  onExit,
  showExit = true,
}: Props) {
  const focusedWorkspace = snapshot.workspaces.find(item => item.focused) || snapshot.workspaces[0];
  const [workspaceId, setWorkspaceId] = useState(focusedWorkspace?.workspace_id || '');
  const [tabId, setTabId] = useState(focusedWorkspace?.active_tab_id || '');
  const [editorMode, setEditorMode] = useState<EditorMode | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [busy, setBusy] = useState(false);
  const wasVisible = useRef(false);
  const pendingFocus = useRef<PendingFocus | null>(null);

  const workspace = snapshot.workspaces.find(item => item.workspace_id === workspaceId) || focusedWorkspace;
  const tabs = snapshot.tabs.filter(item => item.workspace_id === workspace?.workspace_id);
  const selectedTab = tabs.find(item => item.tab_id === tabId) || tabs.find(item => item.focused) || tabs[0];
  const panes = snapshot.panes.filter(item => item.tab_id === selectedTab?.tab_id);
  const selectedPane = panes.find(item => item.terminal_id === terminalState.activeTerminalId)
    || panes.find(item => item.focused)
    || panes[0];
  const activeTerminalSession = terminalState.sessions.find(
    session => session.terminalId === terminalState.activeTerminalId,
  );

  useEffect(() => {
    const pending = pendingFocus.current;
    if (pending?.kind === 'workspace') {
      const previousStillPresent = snapshot.workspaces.some(item => item.workspace_id === pending.previousId);
      const nextWorkspace = snapshot.workspaces.find(item => item.focused) || snapshot.workspaces[0];
      const focusUnchanged = nextWorkspace?.workspace_id === pending.previousId;
      if ((pending.mode === 'create' && focusUnchanged) || (pending.mode === 'close' && previousStillPresent)) return;
      if (nextWorkspace) {
        const nextTabs = snapshot.tabs.filter(item => item.workspace_id === nextWorkspace.workspace_id);
        const nextTab = nextTabs.find(item => item.focused)
          || nextTabs.find(item => item.tab_id === nextWorkspace.active_tab_id)
          || nextTabs[0];
        setWorkspaceId(nextWorkspace.workspace_id);
        setTabId(nextTab?.tab_id || '');
      } else {
        setWorkspaceId('');
        setTabId('');
      }
      pendingFocus.current = null;
      return;
    }
    if (pending?.kind === 'tab') {
      const previousStillPresent = snapshot.tabs.some(item => item.tab_id === pending.previousId);
      const serverWorkspace = snapshot.workspaces.find(item => item.focused) || workspace;
      const serverTabs = snapshot.tabs.filter(item => item.workspace_id === serverWorkspace?.workspace_id);
      const nextTab = serverTabs.find(item => item.focused)
        || serverTabs.find(item => item.tab_id === serverWorkspace?.active_tab_id)
        || serverTabs[0];
      const focusUnchanged = nextTab?.tab_id === pending.previousId;
      if ((pending.mode === 'create' && focusUnchanged) || (pending.mode === 'close' && previousStillPresent)) return;
      if (serverWorkspace) setWorkspaceId(serverWorkspace.workspace_id);
      setTabId(nextTab?.tab_id || '');
      pendingFocus.current = null;
      return;
    }
    if (workspace && workspace.workspace_id !== workspaceId) setWorkspaceId(workspace.workspace_id);
    if (selectedTab && selectedTab.tab_id !== tabId) setTabId(selectedTab.tab_id);
  }, [selectedTab, snapshot.tabs, snapshot.workspaces, tabId, workspace, workspaceId]);

  // Opening a pane from Herd/Agent detail should land in the matching Herdr tab.
  useEffect(() => {
    if (visible && !wasVisible.current && terminalState.activeTerminalId) {
      const activeSession = terminalState.sessions.find(item => item.terminalId === terminalState.activeTerminalId);
      const activePane = snapshot.panes.find(item => item.pane_id === activeSession?.paneId);
      if (activePane) {
        setWorkspaceId(activePane.workspace_id);
        setTabId(activePane.tab_id);
      }
    }
    wasVisible.current = visible;
  }, [snapshot.panes, terminalState.activeTerminalId, terminalState.sessions, visible]);

  // A Herdr tab is a live terminal surface. Attach its focused pane immediately.
  useEffect(() => {
    if (!visible || !selectedTab || panes.length === 0) return;
    const activeBelongsToTab = panes.some(item => item.terminal_id === terminalState.activeTerminalId);
    if (!activeBelongsToTab) onActivateTerminal(panes.find(item => item.focused) || panes[0]);
  }, [onActivateTerminal, panes, selectedTab, terminalState.activeTerminalId, visible]);

  const run = async (action: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    try {
      await action();
      await onRefresh();
      return true;
    } catch (error) {
      Alert.alert('Herdr command failed', String(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const chooseWorkspace = (item: WorkspaceInfo) => {
    const nextTabs = snapshot.tabs.filter(tab => tab.workspace_id === item.workspace_id);
    const nextTab = nextTabs.find(tab => tab.focused)
      || nextTabs.find(tab => tab.tab_id === item.active_tab_id)
      || nextTabs[0];
    setWorkspaceId(item.workspace_id);
    setTabId(nextTab?.tab_id || '');
    const nextPanes = snapshot.panes.filter(pane => pane.tab_id === nextTab?.tab_id);
    const nextPane = nextPanes.find(pane => pane.focused) || nextPanes[0];
    if (nextPane) onActivateTerminal(nextPane);
    run(() => client.focusWorkspace(item.workspace_id));
  };

  const chooseTab = (item: TabInfo) => {
    setWorkspaceId(item.workspace_id);
    setTabId(item.tab_id);
    const nextPanes = snapshot.panes.filter(pane => pane.tab_id === item.tab_id);
    const nextPane = nextPanes.find(pane => pane.focused) || nextPanes[0];
    if (nextPane) onActivateTerminal(nextPane);
    run(async () => {
      if (item.workspace_id !== workspace?.workspace_id) await client.focusWorkspace(item.workspace_id);
      await client.focusTab(item.tab_id);
    });
  };

  const create = async () => {
    let succeeded = true;
    if (editorMode === 'workspace') {
      pendingFocus.current = {
        kind: 'workspace',
        mode: 'create',
        previousId: snapshot.workspaces.find(item => item.focused)?.workspace_id || workspace?.workspace_id || null,
      };
      succeeded = await run(() => client.createWorkspace(name, cwd));
    } else if (editorMode === 'rename-workspace' && workspace) {
      succeeded = await run(() => client.renameWorkspace(workspace.workspace_id, name));
    } else if (editorMode === 'rename-tab' && selectedTab) {
      succeeded = await run(() => client.renameTab(selectedTab.tab_id, name));
    } else if (workspace) {
      pendingFocus.current = {
        kind: 'tab',
        mode: 'create',
        previousId: snapshot.tabs.find(item => item.focused)?.tab_id || selectedTab?.tab_id || null,
      };
      succeeded = await run(() => client.createTab(workspace.workspace_id, name));
    }
    if (!succeeded) pendingFocus.current = null;
    setName('');
    setCwd('');
    setEditorMode(null);
  };

  const openRenameTab = () => {
    if (!selectedTab) return;
    setName(selectedTab.label);
    setEditorMode('rename-tab');
    setMenuOpen(false);
  };

  const openRenameWorkspace = () => {
    if (!workspace) return;
    setName(workspace.label);
    setEditorMode('rename-workspace');
    setMenuOpen(false);
  };

  const confirmCloseTab = () => {
    if (!selectedTab) return;
    setMenuOpen(false);
    Alert.alert('Close Herdr tab?', selectedTab.label || selectedTab.tab_id, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Close',
        style: 'destructive',
        onPress: async () => {
          pendingFocus.current = { kind: 'tab', mode: 'close', previousId: selectedTab.tab_id };
          if (!await run(() => client.closeTab(selectedTab.tab_id))) pendingFocus.current = null;
        },
      },
    ]);
  };

  const confirmCloseWorkspace = () => {
    if (!workspace) return;
    setMenuOpen(false);
    Alert.alert('Close Herdr workspace?', workspace.label || workspace.workspace_id, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Close',
        style: 'destructive',
        onPress: async () => {
          pendingFocus.current = { kind: 'workspace', mode: 'close', previousId: workspace.workspace_id };
          if (!await run(() => client.closeWorkspace(workspace.workspace_id))) pendingFocus.current = null;
        },
      },
    ]);
  };

  return (
    <View style={[styles.page, !visible && styles.hidden]}>
      <View style={styles.topBar}>
        {showExit && (
          <Pressable accessibilityLabel="Back to herd" onPress={onExit} style={styles.back}>
            <Text style={styles.backText}>‹</Text>
          </Pressable>
        )}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.sessionScroll} contentContainerStyle={styles.sessionRail}>
          {snapshot.workspaces.map(item => {
            const active = item.workspace_id === workspace?.workspace_id;
            return (
              <View key={item.workspace_id} style={[styles.sessionChip, active && styles.sessionChipActive]}>
                <Pressable onPress={() => chooseWorkspace(item)} onLongPress={active ? openRenameWorkspace : undefined} style={styles.sessionMain}>
                  <View style={[styles.dot, { backgroundColor: statusColor(item.agent_status) }]} />
                  <Text numberOfLines={1} style={[styles.sessionText, active && styles.sessionTextActive]}>{item.label || item.workspace_id}</Text>
                  <Text style={[styles.sessionCount, active && styles.sessionCountActive]}>{item.tab_count}</Text>
                </Pressable>
              </View>
            );
          })}
        </ScrollView>
        <Pressable accessibilityLabel="New workspace" disabled={busy} onPress={() => setEditorMode('workspace')} style={[styles.headerAction, styles.newSpaceAction]}>
          <Text style={styles.headerActionText}>+ SPACE</Text>
        </Pressable>
        <Pressable accessibilityLabel="Session actions" onPress={() => setMenuOpen(value => !value)} style={styles.headerAction}>
          <Text style={styles.menuText}>•••</Text>
        </Pressable>
      </View>

      {workspace && (
        <View style={styles.tabBar}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabRail}>
            {tabs.map(item => {
              const active = item.tab_id === selectedTab?.tab_id;
              const itemPanes = snapshot.panes.filter(pane => pane.tab_id === item.tab_id);
              const itemSession = terminalState.sessions.find(session => itemPanes.some(pane => pane.terminal_id === session.terminalId));
              return (
                <Pressable key={item.tab_id} onPress={() => chooseTab(item)} onLongPress={active ? openRenameTab : undefined} style={[styles.tab, active && styles.tabActive]}>
                  <View style={[styles.dot, { backgroundColor: itemSession ? terminalStatusColor(itemSession.status) : statusColor(item.agent_status) }]} />
                  <Text numberOfLines={1} style={[styles.tabText, active && styles.tabTextActive]}>{item.label || item.tab_id}</Text>
                  {item.pane_count > 1 && <Text style={[styles.sessionCount, active && styles.sessionCountActive]}>{item.pane_count}</Text>}
                </Pressable>
              );
            })}
          </ScrollView>
          <Pressable accessibilityLabel="New tab" disabled={busy} onPress={() => setEditorMode('tab')} style={styles.addTab}>
            <Text style={styles.headerActionText}>+ TAB</Text>
          </Pressable>
        </View>
      )}

      {menuOpen && (
        <View style={styles.actionMenu}>
          <MenuAction label="RENAME SPACE" disabled={!workspace} onPress={openRenameWorkspace} />
          <MenuAction label="RENAME TAB" disabled={!selectedTab} onPress={openRenameTab} />
          <MenuAction label="PANE" disabled={!selectedPane} onPress={() => { if (selectedPane) onOpenPane(selectedPane); setMenuOpen(false); }} />
          <MenuAction label="CLOSE TAB" danger disabled={!selectedTab} onPress={confirmCloseTab} />
          <MenuAction label="CLOSE SPACE" danger disabled={!workspace} onPress={confirmCloseWorkspace} />
        </View>
      )}

      {editorMode && (
        <View style={styles.editor}>
          <Text style={styles.editorLabel}>{editorMode.startsWith('rename') ? 'RENAME' : 'NEW'} {editorMode.replace('rename-', '').toUpperCase()}</Text>
          <TextInput value={name} onChangeText={setName} placeholder="Label (optional)" placeholderTextColor={colors.muted} style={styles.input} />
          {editorMode === 'workspace' && (
            <TextInput value={cwd} onChangeText={setCwd} placeholder="Working directory (optional)" placeholderTextColor={colors.muted} autoCapitalize="none" style={styles.input} />
          )}
          <Pressable onPress={() => setEditorMode(null)} style={styles.editorButton}><Text style={styles.editorCancel}>CANCEL</Text></Pressable>
          <Pressable onPress={create} style={[styles.editorButton, styles.editorSave]}><Text style={styles.editorSaveText}>SAVE</Text></Pressable>
        </View>
      )}

      {selectedTab && panes.length > 1 && (
        <View style={styles.paneBar}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.paneRail}>
            {panes.map(pane => {
              const active = pane.terminal_id === selectedPane?.terminal_id;
              return (
                <Pressable key={pane.pane_id} onPress={() => onActivateTerminal(pane)} onLongPress={() => onOpenPane(pane)} style={[styles.pane, active && styles.paneActive]}>
                  <View style={[styles.paneDot, { backgroundColor: statusColor(pane.agent_status) }]} />
                  <Text numberOfLines={1} style={[styles.paneText, active && styles.paneTextActive]}>{pane.label || pane.display_agent || pane.agent || 'shell'}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      )}

      <View style={styles.terminalStage}>
        {visible && activeTerminalSession && (
          <TerminalScreen
            key={activeTerminalSession.terminalId}
            client={client}
            compact
            visible
            session={activeTerminalSession}
            preferences={terminalPreferences}
            onClose={() => onCloseTerminal(activeTerminalSession.terminalId)}
            onStatus={(status, error, reconnectAttempt) => onTerminalStatus(activeTerminalSession.terminalId, status, error, reconnectAttempt)}
          />
        )}
        {!selectedTab && (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{workspace ? 'EMPTY WORKSPACE' : 'NO WORKSPACES'}</Text>
            <Text style={styles.emptyText}>{workspace ? 'Create a Herdr tab to open a terminal.' : 'Create a Herdr workspace to begin.'}</Text>
          </View>
        )}
        {selectedTab && panes.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>EMPTY TAB</Text>
            <Text style={styles.emptyText}>Create or move a pane here from Herdr.</Text>
          </View>
        )}
      </View>
    </View>
  );
}

function MenuAction({ label, onPress, disabled = false, danger = false }: { label: string; onPress: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <Pressable disabled={disabled} onPress={onPress} style={[styles.menuAction, disabled && styles.menuActionDisabled]}>
      <Text style={[styles.menuActionText, danger && styles.menuActionDanger]}>{label}</Text>
    </Pressable>
  );
}

function terminalStatusColor(status: TerminalSessionStatus): string {
  if (status === 'connected') return colors.done;
  if (status === 'connecting') return colors.working;
  if (status === 'error') return colors.blocked;
  return colors.idle;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.ink },
  hidden: { display: 'none' },
  topBar: { height: 44, flexDirection: 'row', backgroundColor: colors.panel, borderBottomColor: colors.line, borderBottomWidth: 1 },
  back: { width: 42, alignItems: 'center', justifyContent: 'center' },
  backText: { color: colors.text, fontSize: 30, fontWeight: '300', marginTop: -3 },
  sessionScroll: { flex: 1, minWidth: 0 },
  sessionRail: { alignItems: 'center', paddingHorizontal: 4, gap: 6 },
  sessionChip: { maxWidth: 180, height: 28, flexDirection: 'row', alignItems: 'center', borderRadius: 14, backgroundColor: colors.panelRaised, borderColor: colors.line, borderWidth: 1, overflow: 'hidden' },
  sessionChipActive: { backgroundColor: colors.acid, borderColor: colors.acid },
  sessionMain: { minWidth: 0, flexShrink: 1, height: 28, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10 },
  sessionText: { color: colors.muted, fontSize: 10, fontWeight: '700', maxWidth: 128 },
  sessionTextActive: { color: colors.ink },
  sessionCount: { color: colors.muted, fontFamily: 'monospace', fontSize: 8 },
  sessionCountActive: { color: colors.ink },
  dot: { width: 6, height: 6, borderRadius: 3 },
  headerAction: { width: 42, alignItems: 'center', justifyContent: 'center', borderLeftColor: colors.line, borderLeftWidth: 1 },
  newSpaceAction: { width: 74 },
  headerActionText: { color: colors.acid, fontFamily: 'monospace', fontSize: 9, fontWeight: '900', letterSpacing: 0.3 },
  menuText: { color: colors.text, fontSize: 12, letterSpacing: 1 },
  tabBar: { height: 39, flexDirection: 'row', backgroundColor: colors.panelRaised, borderBottomColor: colors.line, borderBottomWidth: 1 },
  tabRail: { alignItems: 'center', paddingHorizontal: 6, gap: 5 },
  tab: { maxWidth: 170, height: 27, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, borderRadius: 14, borderColor: colors.line, borderWidth: 1, backgroundColor: colors.ink },
  tabActive: { backgroundColor: colors.acid, borderColor: colors.acid },
  tabText: { color: colors.muted, fontSize: 10, fontWeight: '700', maxWidth: 122 },
  tabTextActive: { color: colors.ink },
  addTab: { width: 62, alignItems: 'center', justifyContent: 'center', borderLeftColor: colors.line, borderLeftWidth: 1 },
  actionMenu: { minHeight: 42, flexDirection: 'row', alignItems: 'stretch', backgroundColor: colors.panel, borderBottomColor: colors.line, borderBottomWidth: 1 },
  menuAction: { flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4, borderRightColor: colors.line, borderRightWidth: 1 },
  menuActionDisabled: { opacity: 0.35 },
  menuActionText: { color: colors.text, fontFamily: 'monospace', fontSize: 7, fontWeight: '800', textAlign: 'center' },
  menuActionDanger: { color: colors.blocked },
  editor: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 7, backgroundColor: colors.panelRaised, borderBottomColor: colors.acid, borderBottomWidth: 1 },
  editorLabel: { color: colors.acid, fontFamily: 'monospace', fontSize: 8 },
  input: { minWidth: 110, flex: 1, height: 34, color: colors.text, backgroundColor: colors.ink, borderColor: colors.line, borderWidth: 1, paddingHorizontal: 8, fontFamily: 'monospace', fontSize: 10 },
  editorButton: { height: 34, paddingHorizontal: 8, justifyContent: 'center' },
  editorCancel: { color: colors.muted, fontFamily: 'monospace', fontSize: 8 },
  editorSave: { backgroundColor: colors.acid },
  editorSaveText: { color: colors.ink, fontFamily: 'monospace', fontSize: 8, fontWeight: '900' },
  paneBar: { height: 37, flexDirection: 'row', backgroundColor: colors.panel, borderBottomColor: colors.line, borderBottomWidth: 1 },
  paneRail: { alignItems: 'center', paddingHorizontal: 6, gap: 5 },
  pane: { maxWidth: 160, height: 25, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 9, borderRadius: 13, backgroundColor: colors.panelRaised },
  paneActive: { backgroundColor: colors.acid },
  paneDot: { width: 5, height: 5, borderRadius: 3 },
  paneText: { color: colors.muted, fontSize: 10, fontWeight: '700', maxWidth: 126 },
  paneTextActive: { color: colors.ink },
  terminalStage: { flex: 1, backgroundColor: colors.ink },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  emptyTitle: { color: colors.text, fontFamily: 'monospace', fontWeight: '900' },
  emptyText: { color: colors.muted, textAlign: 'center', marginTop: 8 },
});
