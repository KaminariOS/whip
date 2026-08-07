import { Layers3, Plus, X } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { compareAgentStatusPriority } from '@/src/herdQueue';
import { aggregateAgentStatus } from '@/src/liveHostSessions';
import { cn } from '@/src/lib/utils';
import { appGlassControlStyle, statusColor, useTheme } from '@/src/theme';
import type { WorkspaceInfo } from '@/src/types';
import { AnimatedAgentStatusGlyph, hapticPress } from './app-ui';
import { GlassSurface, useAppGlassEnabled } from './GlassSurface';
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
  const orderedWorkspaces = [...workspaces].sort((a, b) => (
    compareAgentStatusPriority(a.agent_status, b.agent_status)
  ));

  return (
    <GlassSurface className="h-[62px] flex-row border-b border-white/30 dark:border-white/10">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="min-w-0 flex-1" contentContainerClassName="items-center px-1 gap-1.5">
        <WorkspacePill
          label={t('rail.allSpaces')}
          status={allStatus}
          count={totalTabs}
          active={selectedWorkspaceId === null}
          aggregate
          busy={busy}
          onPress={() => onSelect(null)}
        />
        {orderedWorkspaces.map(workspace => (
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
      <Button accessibilityLabel={t('rail.newWorkspace')} className="h-[62px] w-12 rounded-none px-0" disabled={busy} variant="ghost" onPress={hapticPress(onNew)}>
        <Plus size={17} color={colors.text} />
      </Button>
    </GlassSurface>
  );
}

function WorkspacePill({
  label,
  status,
  count,
  active,
  aggregate = false,
  busy,
  onPress,
  onLongPress,
  onClose,
}: {
  label: string;
  status: WorkspaceInfo['agent_status'];
  count: number;
  active: boolean;
  aggregate?: boolean;
  busy: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  onClose?: () => void;
}) {
  const { colors } = useTheme();
  const appGlassEnabled = useAppGlassEnabled();
  const activeTextClass = active
    ? appGlassEnabled
      ? 'text-primary'
      : 'text-primary-foreground'
    : undefined;
  const { t } = useTranslation();
  return (
    <View
      className={cn(
        'h-[42px] max-w-[190px] flex-row items-center rounded-full',
        appGlassEnabled && 'border',
        !appGlassEnabled && 'bg-muted',
        !appGlassEnabled && !active && 'border border-border',
        !appGlassEnabled && active && 'bg-primary',
      )}
      style={appGlassEnabled ? appGlassControlStyle(active, colors) : undefined}>
      <Button accessibilityLabel={t('rail.workspaceStatus', { workspace: label, status })} accessibilityRole="radio" accessibilityState={{ selected: active }} className="h-[42px] min-w-0 flex-shrink justify-start gap-1.5 rounded-none px-2.5 py-0" variant="ghost" onPress={hapticPress(onPress)} onLongPress={onLongPress ? hapticPress(onLongPress) : undefined}>
        <AnimatedAgentStatusGlyph status={status} color={statusColor(status, colors)} size={12} />
        {aggregate ? (
          <Layers3 size={15} color={active ? (appGlassEnabled ? colors.primary : colors.onPrimary) : colors.text} />
        ) : (
          <Text numberOfLines={1} className={cn('max-w-[104px] pb-0.5 text-[11px] font-semibold leading-[18px] text-muted-foreground', activeTextClass)}>{label}</Text>
        )}
        <Text className={cn('font-mono text-[8px] leading-[18px] text-muted-foreground', activeTextClass)}>{count}</Text>
      </Button>
      {onClose ? <Button accessibilityLabel={t('rail.closeWorkspace', { workspace: label })} className="h-[42px] w-7 rounded-none px-0" disabled={busy} variant="ghost" onPress={hapticPress(onClose)}><X size={14} color={active ? (appGlassEnabled ? colors.primary : colors.onPrimary) : colors.textSecondary} /></Button> : null}
    </View>
  );
}
