import Ionicons from '@expo/vector-icons/Ionicons';
import { ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { aggregateAgentStatus } from '@/src/liveHostSessions';
import { cn } from '@/src/lib/utils';
import { colors, statusColor } from '@/src/theme';
import type { WorkspaceInfo } from '@/src/types';
import { AnimatedAgentStatusGlyph, hapticPress } from './app-ui';
import { Button } from './ui/button';
import { Text } from './ui/text';

interface Props {
  workspaces: WorkspaceInfo[];
  selectedWorkspaceId: string | null;
  busy: boolean;
  onSelect: (workspaceId: string | null) => void;
  onNew: () => void;
  onActions: () => void;
  onRename: (workspace: WorkspaceInfo) => void;
}

export function WorkspaceRail({
  workspaces,
  selectedWorkspaceId,
  busy,
  onSelect,
  onNew,
  onActions,
  onRename,
}: Props) {
  const { t } = useTranslation();
  const allStatus = aggregateAgentStatus(workspaces.map(workspace => workspace.agent_status));
  const totalTabs = workspaces.reduce((total, workspace) => total + workspace.tab_count, 0);

  return (
    <View className="h-12 flex-row border-b border-[#424242] bg-[#181818]">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="min-w-0 flex-1" contentContainerClassName="items-center px-1 gap-1.5">
        <WorkspacePill
          label={t('rail.allSpaces')}
          status={allStatus}
          count={totalTabs}
          active={selectedWorkspaceId === null}
          onPress={() => onSelect(null)}
        />
        {workspaces.map(workspace => (
          <WorkspacePill
            key={workspace.workspace_id}
            label={workspace.label || workspace.workspace_id}
            status={workspace.agent_status}
            count={workspace.tab_count}
            active={workspace.workspace_id === selectedWorkspaceId}
            onPress={() => onSelect(workspace.workspace_id)}
            onLongPress={() => onRename(workspace)}
          />
        ))}
      </ScrollView>
      <Button accessibilityLabel={t('rail.newWorkspace')} className="h-12 w-[72px] rounded-none px-1" disabled={busy} variant="ghost" onPress={hapticPress(onNew)}>
        <Ionicons name="add" size={15} color={colors.text} /><Text className="text-[10px] font-semibold text-[#ECECEC]">{t('rail.space')}</Text>
      </Button>
      <Button accessibilityLabel={t('rail.workspaceActions')} className="h-12 w-11 rounded-none px-0" variant="ghost" onPress={hapticPress(onActions)}>
        <Ionicons name="ellipsis-horizontal" size={18} color={colors.text} />
      </Button>
    </View>
  );
}

function WorkspacePill({
  label,
  status,
  count,
  active,
  onPress,
  onLongPress,
}: {
  label: string;
  status: WorkspaceInfo['agent_status'];
  count: number;
  active: boolean;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Button accessibilityLabel={t('rail.workspaceStatus', { workspace: label, status })} accessibilityRole="radio" accessibilityState={{ selected: active }} className={cn('h-8 max-w-[180px] flex-row rounded-full bg-[#2F2F2F] px-[11px] py-0', active && 'bg-[#FFFFFF]')} variant="ghost" onPress={hapticPress(onPress)} onLongPress={onLongPress ? hapticPress(onLongPress) : undefined}>
      <AnimatedAgentStatusGlyph status={status} color={statusColor(status)} size={12} />
      <Text numberOfLines={1} className={cn('max-w-32 pb-0.5 text-[11px] font-semibold leading-[18px] text-[#B4B4B4]', active && 'text-[#212121]')}>{label}</Text>
      <Text className={cn('font-mono text-[8px] leading-[18px] text-[#B4B4B4]', active && 'text-[#212121]')}>{count}</Text>
    </Button>
  );
}
