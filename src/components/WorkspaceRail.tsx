import { Ellipsis, Plus } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { aggregateAgentStatus } from '@/src/liveHostSessions';
import { cn } from '@/src/lib/utils';
import { statusColor, useTheme } from '@/src/theme';
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
  const { colors } = useTheme();
  const { t } = useTranslation();
  const allStatus = aggregateAgentStatus(workspaces.map(workspace => workspace.agent_status));
  const totalTabs = workspaces.reduce((total, workspace) => total + workspace.tab_count, 0);

  return (
    <View className="h-12 flex-row border-b border-border bg-background">
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
        <Plus size={15} color={colors.text} /><Text className="text-[10px] font-semibold text-foreground">{t('rail.space')}</Text>
      </Button>
      <Button accessibilityLabel={t('rail.workspaceActions')} className="h-12 w-11 rounded-none px-0" variant="ghost" onPress={hapticPress(onActions)}>
        <Ellipsis size={18} color={colors.text} />
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
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
    <Button accessibilityLabel={t('rail.workspaceStatus', { workspace: label, status })} accessibilityRole="radio" accessibilityState={{ selected: active }} className={cn('h-8 max-w-[180px] flex-row rounded-full bg-muted px-[11px] py-0', active && 'bg-primary')} variant="ghost" onPress={hapticPress(onPress)} onLongPress={onLongPress ? hapticPress(onLongPress) : undefined}>
      <AnimatedAgentStatusGlyph status={status} color={statusColor(status, colors)} size={12} />
      <Text numberOfLines={1} className={cn('max-w-32 pb-0.5 text-[11px] font-semibold leading-[18px] text-muted-foreground', active && 'text-primary-foreground')}>{label}</Text>
      <Text className={cn('font-mono text-[8px] leading-[18px] text-muted-foreground', active && 'text-primary-foreground')}>{count}</Text>
    </Button>
  );
}
