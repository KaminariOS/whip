import Ionicons from '@expo/vector-icons/Ionicons';
import { ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { cn } from '@/src/lib/utils';
import { aggregateAgentStatus } from '@/src/liveHostSessions';
import { colors, statusColor as agentStatusColor } from '@/src/theme';
import type { AgentStatus } from '@/src/types';
import { AnimatedAgentStatusGlyph, hapticPress } from './app-ui';
import { Button } from './ui/button';
import { Text } from './ui/text';

export interface LiveSessionRailItem {
  hostId: string;
  label: string;
  status: 'connecting' | 'connected' | 'reconnecting' | 'error';
  agentStatus: AgentStatus;
  terminalCount: number;
}

interface Props { sessions: LiveSessionRailItem[]; activeHostId: string | null; onSelect: (hostId: string | null) => void; onClose: (hostId: string) => void; onNew: () => void }

export function LiveSessionRail({ sessions, activeHostId, onSelect, onClose, onNew }: Props) {
  const { t } = useTranslation();
  const allHosts: LiveSessionRailItem = {
    hostId: '',
    label: t('rail.allHosts'),
    status: aggregateConnectionStatus(sessions),
    agentStatus: aggregateAgentStatus(sessions.map(session => session.agentStatus)),
    terminalCount: sessions.reduce((total, session) => total + session.terminalCount, 0),
  };

  return (
    <View className="h-12 flex-row items-stretch border-b border-[#424242] bg-[#181818]">
      <ScrollView className="min-w-0 flex-1" contentContainerClassName="items-center px-1 gap-1.5" horizontal showsHorizontalScrollIndicator={false}>
        <HostPill session={allHosts} active={activeHostId === null} onSelect={() => onSelect(null)} />
        {sessions.map(session => {
          const active = session.hostId === activeHostId;
          return <HostPill key={session.hostId} session={session} active={active} onSelect={() => onSelect(session.hostId)} onClose={() => onClose(session.hostId)} />;
        })}
      </ScrollView>
      <Button accessibilityLabel={t('rail.newHostSession')} className="h-12 w-[46px] rounded-none px-0" variant="ghost" onPress={hapticPress(onNew)}><Ionicons name="add" size={22} color={colors.text} /></Button>
    </View>
  );
}

function HostPill({ session, active, onSelect, onClose }: { session: LiveSessionRailItem; active: boolean; onSelect: () => void; onClose?: () => void }) {
  const { t } = useTranslation();
  return (
    <View className={cn('h-8 max-w-[190px] flex-row items-center overflow-hidden rounded-full bg-[#2F2F2F]', active && 'bg-[#ECECEC]')}>
      <Button accessibilityLabel={t(session.hostId ? 'rail.openHost' : 'rail.showHosts', { host: session.label, status: session.agentStatus })} accessibilityRole="radio" accessibilityState={{ selected: active }} className="h-8 min-w-0 flex-shrink justify-start gap-1.5 rounded-none px-2.5 py-0" variant="ghost" onPress={hapticPress(onSelect)}>
        <AnimatedAgentStatusGlyph status={session.agentStatus} color={sessionStatusColor(session)} size={12} />
        <Text className={cn('max-w-[119px] pb-0.5 text-[11px] font-semibold leading-[18px] text-[#ECECEC]', active && 'text-[#212121]')} numberOfLines={1}>{session.label}</Text>
        {session.terminalCount > 0 ? <Text className={cn('text-[10px] leading-[18px] text-[#8E8E8E]', active && 'text-[#212121]')}>{session.terminalCount}</Text> : null}
      </Button>
      {onClose ? <Button accessibilityLabel={t('rail.disconnectHost', { host: session.label })} className="h-8 w-7 rounded-none px-0" variant="ghost" onPress={hapticPress(onClose)}><Ionicons name="close" size={14} color={active ? colors.ink : colors.muted} /></Button> : null}
    </View>
  );
}

function sessionStatusColor(session: LiveSessionRailItem): string {
  if (session.status === 'connected') return agentStatusColor(session.agentStatus);
  if (session.status === 'connecting' || session.status === 'reconnecting') return colors.working;
  return colors.blocked;
}

function aggregateConnectionStatus(sessions: LiveSessionRailItem[]): LiveSessionRailItem['status'] {
  if (sessions.some(session => session.status === 'error')) return 'error';
  if (sessions.some(session => session.status === 'reconnecting')) return 'reconnecting';
  if (sessions.some(session => session.status === 'connecting')) return 'connecting';
  return 'connected';
}
