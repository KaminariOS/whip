import { Plus, X } from 'lucide-react-native';
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
  onRename: (workspace: WorkspaceInfo) => void;
  onClose: (workspace: WorkspaceInfo) => void;
}

export function WorkspaceRail({
  workspaces,
  selectedWorkspaceId,
  busy,
  onSelect,
  onNew,
  onRename,
  onClose,
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
          busy={busy}
          onPress={() => onSelect(null)}
        />
        {workspaces.map(workspace => (
          <WorkspacePill
            key={workspace.workspace_id}
            label={workspace.label || workspace.workspace_id}
            status={workspace.agent_status}
            count={workspace.tab_count}
            active={workspace.workspace_id === selectedWorkspaceId}
            busy={busy}
            onPress={() => onSelect(workspace.workspace_id)}
            onLongPress={() => onRename(workspace)}
            onClose={() => onClose(workspace)}
          />
        ))}
      </ScrollView>
      <Button accessibilityLabel={t('rail.newWorkspace')} className="h-12 w-12 rounded-none px-0" disabled={busy} variant="ghost" onPress={hapticPress(onNew)}>
        <Plus size={17} color={colors.text} />
      </Button>
    </View>
  );
}

function WorkspacePill({
  label,
  status,
  count,
  active,
  busy,
  onPress,
  onLongPress,
  onClose,
}: {
  label: string;
  status: WorkspaceInfo['agent_status'];
  count: number;
  active: boolean;
  busy: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  onClose?: () => void;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
    <View className={cn('h-8 max-w-[190px] flex-row items-center overflow-hidden rounded-full bg-muted', active && 'bg-primary')}>
      <Button accessibilityLabel={t('rail.workspaceStatus', { workspace: label, status })} accessibilityRole="radio" accessibilityState={{ selected: active }} className="h-8 min-w-0 flex-shrink justify-start gap-1.5 rounded-none px-2.5 py-0" variant="ghost" onPress={hapticPress(onPress)} onLongPress={onLongPress ? hapticPress(onLongPress) : undefined}>
        <AnimatedAgentStatusGlyph status={status} color={statusColor(status, colors)} size={12} />
        <Text numberOfLines={1} className={cn('max-w-[104px] pb-0.5 text-[11px] font-semibold leading-[18px] text-muted-foreground', active && 'text-primary-foreground')}>{label}</Text>
        <Text className={cn('font-mono text-[8px] leading-[18px] text-muted-foreground', active && 'text-primary-foreground')}>{count}</Text>
      </Button>
      {onClose ? <Button accessibilityLabel={t('rail.closeWorkspace', { workspace: label })} className="h-8 w-7 rounded-none px-0" disabled={busy} variant="ghost" onPress={hapticPress(onClose)}><X size={14} color={active ? colors.onPrimary : colors.textSecondary} /></Button> : null}
    </View>
  );
}
