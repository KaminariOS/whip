import { useEffect, useEffectEvent, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
  Alert,
  ScrollView,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { cn } from '@/src/lib/utils';
import { serverFocusMatchesPendingPane } from '@/src/lib/terminalFocus';
import type { TerminalControlId, TerminalControlUsage } from '../lib/terminalControls';
import type { HerdrClient } from '../services/HerdrClient';
import type { TerminalSessionsState } from '../terminalSessions';
import type { TerminalSessionStatus } from '../terminalSessions';
import type { TerminalPreferences } from '../services/devicePreferences';
import { colors, sessionTabStatusColor, statusColor } from '../theme';
import type { HerdrSnapshot, PaneInfo, TabInfo } from '../types';
import { AnimatedAgentStatusGlyph, hapticPress } from './app-ui';
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
  terminalControlUsage: TerminalControlUsage;
  onTerminalFontSizeChange: (fontSize: number) => void;
  onTerminalControlUse: (control: TerminalControlId) => void;
  onExit: () => void;
}

type EditorMode = 'tab' | 'rename-tab';
type PendingFocus = {
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
  terminalControlUsage,
  onTerminalFontSizeChange,
  onTerminalControlUse,
  onExit,
}: Props) {
  const { t } = useTranslation();
  const focusedWorkspace = snapshot.workspaces.find(item => item.focused) || snapshot.workspaces[0];
  const [workspaceId, setWorkspaceId] = useState(focusedWorkspace?.workspace_id || '');
  const [tabId, setTabId] = useState(focusedWorkspace?.active_tab_id || '');
  const [editorMode, setEditorMode] = useState<EditorMode | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [terminalSurfaceMounted, setTerminalSurfaceMounted] = useState(visible);
  const pendingPaneFocus = useRef<string | null>(null);
  const lastActivePaneId = useRef<string | null>(null);
  const pendingFocus = useRef<PendingFocus | null>(null);

  useEffect(() => {
    if (visible) setTerminalSurfaceMounted(true);
  }, [visible]);

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
    if (pending) {
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
    if (!serverFocusMatchesPendingPane(serverPaneId, pendingPaneFocus.current)) return;
    setWorkspaceId(serverWorkspaceId);
    setTabId(serverTabId);
  }, [serverPaneId, serverTabId, serverWorkspaceId]);

  // Preserve an explicit terminal choice until Herdr confirms the same pane.
  useEffect(() => {
    if (!visible) {
      pendingPaneFocus.current = null;
      lastActivePaneId.current = null;
      return;
    }
    const activeSession = terminalState.sessions.find(item => item.terminalId === terminalState.activeTerminalId);
    const activePane = snapshot.panes.find(item => item.pane_id === activeSession?.paneId);
    if (!activePane || activePane.pane_id === lastActivePaneId.current) return;
    lastActivePaneId.current = activePane.pane_id;
    pendingPaneFocus.current = activePane.pane_id;
    setWorkspaceId(activePane.workspace_id);
    setTabId(activePane.tab_id);
  }, [snapshot.panes, terminalState.activeTerminalId, terminalState.sessions, visible]);

  const activateServerPane = useEffectEvent((paneId: string) => {
    const pane = snapshot.panes.find(item => item.pane_id === paneId);
    if (pane) onActivateTerminal(pane);
  });

  // A Herdr tab is a live terminal surface. Attach its server-focused pane immediately.
  useEffect(() => {
    if (!visible || !serverPaneId) return;
    if (!serverFocusMatchesPendingPane(serverPaneId, pendingPaneFocus.current)) return;
    pendingPaneFocus.current = null;
    activateServerPane(serverPaneId);
  }, [serverPaneId, visible]);

  const run = async (action: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    try {
      await action();
      await onRefresh();
      return true;
    } catch (error) {
      Alert.alert(t('herd.commandFailed'), String(error));
      return false;
    } finally {
      setBusy(false);
    }
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
    if (editorMode === 'rename-tab' && selectedTab) {
      succeeded = await run(() => client.renameTab(selectedTab.tab_id, name));
    } else if (workspace) {
      pendingFocus.current = {
        mode: 'create',
        previousId: snapshot.tabs.find(item => item.focused)?.tab_id || selectedTab?.tab_id || null,
      };
      succeeded = await run(() => client.createTab(workspace.workspace_id, name));
    }
    if (!succeeded) pendingFocus.current = null;
    setName('');
    setEditorMode(null);
  };

  const openRenameTab = () => {
    if (!selectedTab) return;
    setName(selectedTab.label);
    setEditorMode('rename-tab');
    setMenuOpen(false);
  };

  const closeTab = async (item: TabInfo | undefined = selectedTab) => {
    if (!item) return;
    setMenuOpen(false);
    pendingFocus.current = { mode: 'close', previousId: item.tab_id };
    if (!await run(() => client.closeTab(item.tab_id))) pendingFocus.current = null;
  };

  return (
    <View
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
      pointerEvents={visible ? 'auto' : 'none'}
      className={cn('flex-1 bg-[#212121]', !visible && 'absolute inset-0 opacity-0')}>
      <View className="h-[42px] flex-row border-b border-[#424242] bg-[#2F2F2F]">
        <Button accessibilityLabel={t('session.backToHerd')} className="h-[42px] w-[42px] rounded-none px-0" variant="ghost" onPress={hapticPress(onExit)}>
          <Ionicons name="chevron-back" size={21} color={colors.text} />
        </Button>
        {workspace ? (
          <>
            <ScrollView className="min-w-0 flex-1" horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="items-center px-1.5 gap-[5px]">
              {tabs.map(item => {
                const active = item.tab_id === selectedTab?.tab_id;
                const itemPanes = snapshot.panes.filter(pane => pane.tab_id === item.tab_id);
                const itemSession = terminalState.sessions.find(session => itemPanes.some(pane => pane.terminal_id === session.terminalId));
                const label = item.label || item.tab_id;
                return (
                  <View key={item.tab_id} className={cn('h-[30px] max-w-[170px] flex-row items-center overflow-hidden rounded-full bg-[#212121]', active && 'bg-[#FFFFFF]')}>
                    <Button accessibilityLabel={t('session.openTab', { tab: label })} className="h-[30px] min-w-0 flex-shrink justify-start gap-2 rounded-none px-[11px] py-0 pr-1" variant="ghost" onPress={hapticPress(() => chooseTab(item))} onLongPress={active ? openRenameTab : undefined}>
                      <AnimatedAgentStatusGlyph status={item.agent_status} color={sessionTabStatusColor(item.agent_status, itemSession?.status)} size={12} />
                      <Text numberOfLines={1} className={cn('max-w-[94px] pb-0.5 text-[11px] font-semibold leading-[18px] text-[#B4B4B4]', active && 'text-[#212121]')}>{label}</Text>
                      {item.pane_count > 1 && <Text className={cn('font-mono text-[8px] text-[#B4B4B4]', active && 'text-[#212121]')}>{item.pane_count}</Text>}
                    </Button>
                    <Button accessibilityLabel={t('session.closeTab', { tab: label })} className="h-[30px] w-7 rounded-none px-0" variant="ghost" onPress={hapticPress(() => closeTab(item))}>
                      <Ionicons name="close" size={14} color={active ? colors.ink : colors.muted} />
                    </Button>
                  </View>
                );
              })}
            </ScrollView>
            <Button accessibilityLabel={t('session.newTab')} className="h-[42px] w-[58px] rounded-none px-1" disabled={busy} variant="ghost" onPress={hapticPress(() => setEditorMode('tab'))}><Ionicons name="add" size={14} color={colors.text} /><Text className="text-[10px] font-semibold text-[#ECECEC]">{t('session.tab')}</Text></Button>
            <Button accessibilityLabel={t('session.actions')} className="h-[42px] w-11 rounded-none px-0" variant="ghost" onPress={hapticPress(() => setMenuOpen(value => !value))}>
              <Ionicons name="ellipsis-horizontal" size={18} color={colors.text} />
            </Button>
          </>
        ) : null}
      </View>

      {menuOpen && (
        <View className="min-h-[42px] flex-row items-stretch border-b border-[#424242] bg-[#181818]">
          <MenuAction label={t('session.renameTab')} disabled={!selectedTab} onPress={openRenameTab} />
          <MenuAction label={t('session.paneActions')} disabled={!selectedPane} onPress={() => { if (selectedPane) onOpenPane(selectedPane); setMenuOpen(false); }} />
          <MenuAction label={t('session.closeTabAction')} danger disabled={!selectedTab} onPress={closeTab} />
        </View>
      )}

      {editorMode && (
        <View className="flex-row items-center gap-1.5 border-b border-white bg-[#2F2F2F] p-[7px]">
          <Text className="font-mono text-[8px] text-white">{editorMode.startsWith('rename') ? t('herd.rename') : t('herd.new')} {t('session.tab')}</Text>
          <Input className="h-[34px] min-w-[110px] flex-1 rounded-none border-[#424242] bg-[#212121] px-2 font-mono text-[10px] text-[#ECECEC]" value={name} onChangeText={setName} placeholder={t('herd.labelOptional')} placeholderTextColor={colors.muted} />
          <Button className="h-[34px] rounded-none px-2" variant="ghost" onPress={hapticPress(() => setEditorMode(null))}><Text className="font-mono text-[8px] text-[#B4B4B4]">{t('common.cancel')}</Text></Button>
          <Button className="h-[34px] rounded-none bg-white px-2" onPress={hapticPress(create)}><Text className="font-mono text-[8px] font-black text-[#212121]">{t('common.save')}</Text></Button>
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
        {terminalSurfaceMounted && terminalState.sessions.map(terminalSession => (
          <TerminalScreen
            key={terminalSession.terminalId}
            client={client}
            compact
            visible={visible && terminalSession.terminalId === activeTerminalSession?.terminalId}
            session={terminalSession}
            scroll={snapshot.panes.find(pane => pane.terminal_id === terminalSession.terminalId)?.scroll}
            preferences={terminalPreferences}
            controlUsage={terminalControlUsage}
            onFontSizeChange={onTerminalFontSizeChange}
            onControlUse={onTerminalControlUse}
            onClose={() => onCloseTerminal(terminalSession.terminalId)}
            onStatus={(status, error, reconnectAttempt) => {
              onTerminalStatus(terminalSession.terminalId, status, error, reconnectAttempt);
            }}
          />
        ))}
        {!selectedTab && (
          <View className="flex-1 items-center justify-center p-[30px]">
            <Text className="font-mono font-black text-[#ECECEC]">{workspace ? t('session.emptyWorkspace') : t('session.noWorkspaces')}</Text>
            <Text className="mt-2 text-center text-[#B4B4B4]">{workspace ? t('session.createTab') : t('session.createWorkspace')}</Text>
          </View>
        )}
        {selectedTab && panes.length === 0 && (
          <View className="flex-1 items-center justify-center p-[30px]">
            <Text className="font-mono font-black text-[#ECECEC]">{t('session.emptyTab')}</Text>
            <Text className="mt-2 text-center text-[#B4B4B4]">{t('session.emptyTabCopy')}</Text>
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
