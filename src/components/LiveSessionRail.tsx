import Ionicons from '@expo/vector-icons/Ionicons';
import { ScrollView, View } from 'react-native';

import { cn } from '@/src/lib/utils';
import { colors } from '@/src/theme';
import { hapticPress } from './app-ui';
import { Button } from './ui/button';
import { Text } from './ui/text';

export interface LiveSessionRailItem {
  hostId: string;
  label: string;
  status: 'connecting' | 'connected' | 'reconnecting' | 'error';
  terminalCount: number;
}

interface Props { sessions: LiveSessionRailItem[]; activeHostId: string | null; onExit: () => void; onSelect: (hostId: string) => void; onClose: (hostId: string) => void; onNew: () => void }

export function LiveSessionRail({ sessions, activeHostId, onExit, onSelect, onClose, onNew }: Props) {
  return (
    <View className="h-12 flex-row items-stretch border-b border-[#424242] bg-[#181818]">
      <Button accessibilityLabel="Leave terminals" className="h-12 w-[46px] rounded-none px-0" variant="ghost" onPress={hapticPress(onExit)}><Ionicons name="chevron-back" size={21} color={colors.text} /></Button>
      <ScrollView className="min-w-0 flex-1" contentContainerClassName="items-center px-1 gap-1.5" horizontal showsHorizontalScrollIndicator={false}>
        {sessions.map(session => {
          const active = session.hostId === activeHostId;
          return <View className={cn('h-8 max-w-[190px] flex-row items-center overflow-hidden rounded-full bg-[#2F2F2F]', active && 'bg-[#ECECEC]')} key={session.hostId}><Button accessibilityLabel={`Open ${session.label} session`} className="h-8 min-w-0 flex-shrink justify-start gap-1.5 rounded-none px-2.5" variant="ghost" onPress={hapticPress(() => onSelect(session.hostId))}><View className="size-1.5 rounded-full" style={{ backgroundColor: statusColor(session.status) }} /><Text className={cn('max-w-[125px] text-[11px] font-semibold leading-[15px] text-[#ECECEC]', active && 'text-[#212121]')} numberOfLines={1}>{session.label}</Text>{session.terminalCount > 0 ? <Text className={cn('text-[10px] text-[#8E8E8E]', active && 'text-[#212121]')}>{session.terminalCount}</Text> : null}</Button><Button accessibilityLabel={`Disconnect ${session.label}`} className="h-8 w-7 rounded-none px-0" variant="ghost" onPress={hapticPress(() => onClose(session.hostId))}><Ionicons name="close" size={14} color={active ? colors.ink : colors.muted} /></Button></View>;
        })}
      </ScrollView>
      <Button accessibilityLabel="New host session" className="h-12 w-[46px] rounded-none px-0" variant="ghost" onPress={hapticPress(onNew)}><Ionicons name="add" size={22} color={colors.text} /></Button>
    </View>
  );
}

function statusColor(status: LiveSessionRailItem['status']): string { if (status === 'connected') return colors.done; if (status === 'connecting' || status === 'reconnecting') return colors.working; return colors.blocked; }
