import { useEffect, useEffectEvent, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
  Alert,
  ScrollView,
  View,
} from 'react-native';

import { cn } from '@/src/lib/utils';
import type { HerdrClient } from '../services/HerdrClient';
import type { TerminalSessionsState } from '../terminalSessions';
import type { TerminalSessionStatus } from '../terminalSessions';
import type { TerminalPreferences } from '../services/devicePreferences';
import { colors, statusColor } from '../theme';
import type { HerdrSnapshot, PaneInfo, TabInfo, WorkspaceInfo } from '../types';
import { hapticPress } from './app-ui';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Text } from './ui/text';
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
  onTerminalFontSizeChange: (fontSize: number) => void;
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
  onTerminalFontSizeChange,
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
  const serverWorkspace = snapshot.workspaces.find(item => item.focused) || snapshot.workspaces[0];
  const serverTab = snapshot.tabs.find(item => (
    item.workspace_id === serverWorkspace?.workspace_id
      && item.tab_id === serverWorkspace.active_tab_id
  )) || snapshot.tabs.find(item => item.workspace_id === serverWorkspace?.workspace_id && item.focused);
  const serverPane = snapshot.panes.find(item => item.tab_id === serverTab?.tab_id && item.focused)
    || snapshot.panes.find(item => item.tab_id === serverTab?.tab_id);
  const serverWorkspaceId = serverWorkspace?.workspace_id || '';
  const serverTabId = serverTab?.tab_id || '';
  const serverPaneId = serverPane?.pane_id || '';
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
      const focusedServerWorkspace = snapshot.workspaces.find(item => item.focused) || workspace;
      const serverTabs = snapshot.tabs.filter(item => item.workspace_id === focusedServerWorkspace?.workspace_id);
      const nextTab = serverTabs.find(item => item.focused)
        || serverTabs.find(item => item.tab_id === focusedServerWorkspace?.active_tab_id)
        || serverTabs[0];
      const focusUnchanged = nextTab?.tab_id === pending.previousId;
      if ((pending.mode === 'create' && focusUnchanged) || (pending.mode === 'close' && previousStillPresent)) return;
      if (focusedServerWorkspace) setWorkspaceId(focusedServerWorkspace.workspace_id);
      setTabId(nextTab?.tab_id || '');
      pendingFocus.current = null;
      return;
    }
    if (workspace && workspace.workspace_id !== workspaceId) setWorkspaceId(workspace.workspace_id);
    if (selectedTab && selectedTab.tab_id !== tabId) setTabId(selectedTab.tab_id);
  }, [selectedTab, snapshot.tabs, snapshot.workspaces, tabId, workspace, workspaceId]);

  // Herdr owns focus. Follow focus changes made by the native or another remote client.
  useEffect(() => {
    if (!serverWorkspaceId || !serverTabId) return;
    setWorkspaceId(serverWorkspaceId);
    setTabId(serverTabId);
  }, [serverTabId, serverWorkspaceId]);

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

  const activateServerPane = useEffectEvent((paneId: string) => {
    const pane = snapshot.panes.find(item => item.pane_id === paneId);
    if (pane) onActivateTerminal(pane);
  });

  // A Herdr tab is a live terminal surface. Attach its server-focused pane immediately.
  useEffect(() => {
    if (!visible || !serverPaneId) return;
    activateServerPane(serverPaneId);
  }, [serverPaneId, visible]);

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

  const choosePane = (pane: PaneInfo) => {
    onActivateTerminal(pane);
    run(() => client.focusPane(pane.pane_id));
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
    <View
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
      pointerEvents={visible ? 'auto' : 'none'}
      className={cn('flex-1 bg-[#212121]', !visible && 'absolute inset-0 opacity-0')}>
      <View className="h-12 flex-row border-b border-[#424242] bg-[#181818]">
        {showExit && (
          <Button accessibilityLabel="Back to herd" className="h-12 w-[42px] rounded-none px-0" variant="ghost" onPress={hapticPress(onExit)}>
            <Ionicons name="chevron-back" size={21} color={colors.text} />
          </Button>
        )}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} className="min-w-0 flex-1" contentContainerClassName="items-center px-1 gap-1.5">
          {snapshot.workspaces.map(item => {
            const active = item.workspace_id === workspace?.workspace_id;
            return (
              <Button key={item.workspace_id} className={cn('h-8 max-w-[180px] flex-row rounded-full bg-[#2F2F2F] px-[11px]', active && 'bg-[#FFFFFF]')} variant="ghost" onPress={hapticPress(() => chooseWorkspace(item))} onLongPress={active ? openRenameWorkspace : undefined}>
                <View className="size-1.5 rounded-full" style={{ backgroundColor: statusColor(item.agent_status) }} />
                <Text numberOfLines={1} className={cn('max-w-32 text-[11px] font-semibold text-[#B4B4B4]', active && 'text-[#212121]')}>{item.label || item.workspace_id}</Text>
                <Text className={cn('font-mono text-[8px] text-[#B4B4B4]', active && 'text-[#212121]')}>{item.tab_count}</Text>
              </Button>
            );
          })}
        </ScrollView>
        <Button accessibilityLabel="New workspace" className="h-12 w-[72px] rounded-none px-1" disabled={busy} variant="ghost" onPress={hapticPress(() => setEditorMode('workspace'))}>
          <Ionicons name="add" size={15} color={colors.text} /><Text className="text-[10px] font-semibold text-[#ECECEC]">Space</Text>
        </Button>
        <Button accessibilityLabel="Session actions" className="h-12 w-11 rounded-none px-0" variant="ghost" onPress={hapticPress(() => setMenuOpen(value => !value))}>
          <Ionicons name="ellipsis-horizontal" size={18} color={colors.text} />
        </Button>
      </View>

      {workspace && (
        <View className="h-[42px] flex-row border-b border-[#424242] bg-[#2F2F2F]">
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="items-center px-1.5 gap-[5px]">
            {tabs.map(item => {
              const active = item.tab_id === selectedTab?.tab_id;
              const itemPanes = snapshot.panes.filter(pane => pane.tab_id === item.tab_id);
              const itemSession = terminalState.sessions.find(session => itemPanes.some(pane => pane.terminal_id === session.terminalId));
              return (
                <Button key={item.tab_id} className={cn('h-[30px] max-w-[170px] rounded-full bg-[#212121] px-[11px]', active && 'bg-[#FFFFFF]')} variant="ghost" onPress={hapticPress(() => chooseTab(item))} onLongPress={active ? openRenameTab : undefined}>
                  <View className="size-1.5 rounded-full" style={{ backgroundColor: itemSession ? terminalStatusColor(itemSession.status) : statusColor(item.agent_status) }} />
                  <Text numberOfLines={1} className={cn('max-w-[122px] text-[11px] font-semibold text-[#B4B4B4]', active && 'text-[#212121]')}>{item.label || item.tab_id}</Text>
                  {item.pane_count > 1 && <Text className={cn('font-mono text-[8px] text-[#B4B4B4]', active && 'text-[#212121]')}>{item.pane_count}</Text>}
                </Button>
              );
            })}
          </ScrollView>
          <Button accessibilityLabel="New tab" className="h-[42px] w-[58px] rounded-none px-1" disabled={busy} variant="ghost" onPress={hapticPress(() => setEditorMode('tab'))}><Ionicons name="add" size={14} color={colors.text} /><Text className="text-[10px] font-semibold text-[#ECECEC]">Tab</Text></Button>
        </View>
      )}

      {menuOpen && (
        <View className="min-h-[42px] flex-row items-stretch border-b border-[#424242] bg-[#181818]">
          <MenuAction label="RENAME SPACE" disabled={!workspace} onPress={openRenameWorkspace} />
          <MenuAction label="RENAME TAB" disabled={!selectedTab} onPress={openRenameTab} />
          <MenuAction label="PANE ACTIONS" disabled={!selectedPane} onPress={() => { if (selectedPane) onOpenPane(selectedPane); setMenuOpen(false); }} />
          <MenuAction label="CLOSE TAB" danger disabled={!selectedTab} onPress={confirmCloseTab} />
          <MenuAction label="CLOSE SPACE" danger disabled={!workspace} onPress={confirmCloseWorkspace} />
        </View>
      )}

      {editorMode && (
        <View className="flex-row items-center gap-1.5 border-b border-white bg-[#2F2F2F] p-[7px]">
          <Text className="font-mono text-[8px] text-white">{editorMode.startsWith('rename') ? 'RENAME' : 'NEW'} {editorMode.replace('rename-', '').toUpperCase()}</Text>
          <Input className="h-[34px] min-w-[110px] flex-1 rounded-none border-[#424242] bg-[#212121] px-2 font-mono text-[10px] text-[#ECECEC]" value={name} onChangeText={setName} placeholder="Label (optional)" placeholderTextColor={colors.muted} />
          {editorMode === 'workspace' && (
            <Input className="h-[34px] min-w-[110px] flex-1 rounded-none border-[#424242] bg-[#212121] px-2 font-mono text-[10px] text-[#ECECEC]" value={cwd} onChangeText={setCwd} placeholder="Working directory (optional)" placeholderTextColor={colors.muted} autoCapitalize="none" />
          )}
          <Button className="h-[34px] rounded-none px-2" variant="ghost" onPress={hapticPress(() => setEditorMode(null))}><Text className="font-mono text-[8px] text-[#B4B4B4]">CANCEL</Text></Button>
          <Button className="h-[34px] rounded-none bg-white px-2" onPress={hapticPress(create)}><Text className="font-mono text-[8px] font-black text-[#212121]">SAVE</Text></Button>
        </View>
      )}

      {selectedTab && panes.length > 1 && (
        <View className="h-[37px] flex-row border-b border-[#424242] bg-[#181818]">
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="items-center px-1.5 gap-[5px]">
            {panes.map(pane => {
              const active = pane.terminal_id === selectedPane?.terminal_id;
              return (
                <Button key={pane.pane_id} className={cn('h-7 max-w-40 rounded-full bg-[#2F2F2F] px-2.5', active && 'bg-white')} variant="ghost" onPress={hapticPress(() => choosePane(pane))} onLongPress={() => onOpenPane(pane)}><View className="size-[5px] rounded-full" style={{ backgroundColor: statusColor(pane.agent_status) }} /><Text numberOfLines={1} className={cn('max-w-[126px] text-[11px] font-semibold text-[#B4B4B4]', active && 'text-[#212121]')}>{pane.label || pane.display_agent || pane.agent || 'shell'}</Text></Button>
              );
            })}
          </ScrollView>
        </View>
      )}

      <View className="relative flex-1 overflow-hidden bg-[#212121]">
        {terminalState.sessions.map(terminalSession => (
          <TerminalScreen
            key={terminalSession.terminalId}
            client={client}
            compact
            visible={visible && terminalSession.terminalId === activeTerminalSession?.terminalId}
            session={terminalSession}
            preferences={terminalPreferences}
            onFontSizeChange={onTerminalFontSizeChange}
            onClose={() => onCloseTerminal(terminalSession.terminalId)}
            onStatus={(status, error, reconnectAttempt) => {
              onTerminalStatus(terminalSession.terminalId, status, error, reconnectAttempt);
            }}
          />
        ))}
        {!selectedTab && (
          <View className="flex-1 items-center justify-center p-[30px]">
            <Text className="font-mono font-black text-[#ECECEC]">{workspace ? 'EMPTY WORKSPACE' : 'NO WORKSPACES'}</Text>
            <Text className="mt-2 text-center text-[#B4B4B4]">{workspace ? 'Create a Herdr tab to open a terminal.' : 'Create a Herdr workspace to begin.'}</Text>
          </View>
        )}
        {selectedTab && panes.length === 0 && (
          <View className="flex-1 items-center justify-center p-[30px]">
            <Text className="font-mono font-black text-[#ECECEC]">EMPTY TAB</Text>
            <Text className="mt-2 text-center text-[#B4B4B4]">Create or move a pane here from Herdr.</Text>
          </View>
        )}
      </View>
    </View>
  );
}

function MenuAction({ label, onPress, disabled = false, danger = false }: { label: string; onPress: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <Button className="h-auto min-w-0 flex-1 rounded-none border-r border-[#424242] px-1" disabled={disabled} variant="ghost" onPress={hapticPress(onPress)}><Text className={cn('text-center text-[9px] font-semibold text-[#ECECEC]', danger && 'text-[#FF6B6B]')}>{label}</Text></Button>
  );
}

function terminalStatusColor(status: TerminalSessionStatus): string {
  if (status === 'connected') return colors.done;
  if (status === 'connecting') return colors.working;
  if (status === 'error') return colors.blocked;
  return colors.idle;
}
