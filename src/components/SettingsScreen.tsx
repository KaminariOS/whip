import { LogOut, ShieldCheck } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';

import type { TerminalPreferences } from '@/src/services/devicePreferences';
import { hapticPress, IconButton, ScreenHeader } from './app-ui';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Switch } from './ui/switch';
import { Text } from './ui/text';

interface Props {
  alertsEnabled: boolean;
  ttsEnabled: boolean;
  host: string | null;
  onBack: () => void;
  onAlertsChange: (value: boolean) => void;
  onTtsChange: (value: boolean) => void;
  terminalPreferences: TerminalPreferences;
  onTerminalPreferencesChange: (value: TerminalPreferences) => void;
  onDisconnect?: () => void;
}

export function SettingsScreen(props: Props) {
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Settings" left={<IconButton icon="chevron-back" accessibilityLabel="Back" onPress={props.onBack} />} />
      <ScrollView className="flex-1"><View className="p-4 pb-11">
        <View className="mb-7 py-2"><Text className="text-[22px] font-semibold leading-7">{props.host || 'Not connected'}</Text><Text className="mt-1.5 text-sm leading-[21px] text-muted-foreground">{props.host ? 'Dashboard updates and terminal traffic use the authenticated SSH connection.' : 'Select a saved host to open a Herdr connection.'}</Text></View>

        <Text className="mb-3 px-1 text-sm font-semibold text-muted-foreground">Notifications</Text>
        <View className="overflow-hidden rounded-lg border border-border bg-card">
          <SettingRow title="Agent notifications" copy="Notify when an agent is blocked or done." value={props.alertsEnabled} onChange={props.onAlertsChange} />
          <SettingRow title="Speak state changes" copy="Read important transitions with Android TTS." value={props.ttsEnabled} onChange={props.onTtsChange} divided />
        </View>

        <Text className="mb-3 mt-7 px-1 text-sm font-semibold text-muted-foreground">Terminal</Text>
        <View className="overflow-hidden rounded-lg border border-border bg-card">
          <ValueRow title="Font size" value={`${props.terminalPreferences.fontSize}px`} onDecrease={() => props.onTerminalPreferencesChange({ ...props.terminalPreferences, fontSize: Math.max(8, props.terminalPreferences.fontSize - 1) })} onIncrease={() => props.onTerminalPreferencesChange({ ...props.terminalPreferences, fontSize: Math.min(16, props.terminalPreferences.fontSize + 1) })} />
          <ValueRow title="Scrollback" value={`${props.terminalPreferences.scrollback} lines`} onDecrease={() => props.onTerminalPreferencesChange({ ...props.terminalPreferences, scrollback: Math.max(1000, props.terminalPreferences.scrollback - 1000) })} onIncrease={() => props.onTerminalPreferencesChange({ ...props.terminalPreferences, scrollback: Math.min(20000, props.terminalPreferences.scrollback + 1000) })} divided />
          <SettingRow title="Blinking cursor" copy="Animate the terminal cursor while the pane is active." value={props.terminalPreferences.cursorBlink} onChange={value => props.onTerminalPreferencesChange({ ...props.terminalPreferences, cursorBlink: value })} divided />
        </View>

        <View className="mt-7 flex-row items-start gap-3 rounded-lg bg-muted p-4"><Icon as={ShieldCheck} size={21} /><View className="flex-1"><Text className="text-sm font-semibold leading-[19px]">Private SSH boundary</Text><Text className="mt-1 text-xs leading-[18px] text-muted-foreground">Herdr is not exposed to the network. Dashboard actions and terminal bytes travel through SSH to your device.</Text></View></View>

        {props.onDisconnect ? <Button className="mt-6 rounded-full" variant="destructive" onPress={hapticPress(props.onDisconnect)}><Icon as={LogOut} className="text-destructive-foreground" size={17} /><Text>Disconnect SSH</Text></Button> : null}
      </View></ScrollView>
    </View>
  );
}

function ValueRow({ title, value, onDecrease, onIncrease, divided = false }: { title: string; value: string; onDecrease: () => void; onIncrease: () => void; divided?: boolean }) {
  return <View className={divided ? 'min-h-16 flex-row items-center border-t border-border px-3.5' : 'min-h-16 flex-row items-center px-3.5'}><Text className="text-[15px] font-semibold leading-5">{title}</Text><View className="ml-auto flex-row items-center"><IconButton icon="remove" accessibilityLabel={`Decrease ${title}`} className="size-9" onPress={onDecrease} /><Text className="min-w-[92px] text-center text-xs text-muted-foreground">{value}</Text><IconButton icon="add" accessibilityLabel={`Increase ${title}`} className="size-9" onPress={onIncrease} /></View></View>;
}

function SettingRow({ title, copy, value, onChange, divided = false }: { title: string; copy: string; value: boolean; onChange: (value: boolean) => void; divided?: boolean }) {
  return <View className={divided ? 'min-h-[82px] flex-row items-center border-t border-border p-3.5' : 'min-h-[82px] flex-row items-center p-3.5'}><View className="flex-1 pr-[18px]"><Text className="text-[15px] font-semibold leading-5">{title}</Text><Text className="mt-0.5 text-xs leading-[17px] text-muted-foreground">{copy}</Text></View><Switch checked={value} onCheckedChange={onChange} /></View>;
}
