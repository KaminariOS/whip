import { ChevronRight, ImagePlus, KeyRound, LogOut, Minus, Plus, ShieldCheck, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { Alert, Image, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { AppearancePreference, LanguagePreference, TerminalPreferences } from '@/src/services/devicePreferences';
import { removeTerminalBackgroundImage, selectTerminalBackgroundImage } from '@/src/services/terminalBackground';
import { hapticPress, IconButton } from './app-ui';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Switch } from './ui/switch';
import { Text } from './ui/text';

export interface SettingsSectionProps {
  alertsEnabled: boolean;
  ttsEnabled: boolean;
  biometricForKeys: boolean;
  biometricOnResume: boolean;
  globalKeyCount: number;
  appearance: AppearancePreference;
  language: LanguagePreference;
  keepScreenOn: boolean;
  reopenTerminalOnLaunch: boolean;
  host: string | null;
  onAlertsChange: (value: boolean) => void;
  onTtsChange: (value: boolean) => void;
  onBiometricForKeysChange: (value: boolean) => void;
  onBiometricOnResumeChange: (value: boolean) => void;
  onManageGlobalKeychain: () => void;
  onAppearanceChange: (value: AppearancePreference) => void;
  onLanguageChange: (value: LanguagePreference) => void;
  onKeepScreenOnChange: (value: boolean) => void;
  onReopenTerminalOnLaunchChange: (value: boolean) => void;
  terminalPreferences: TerminalPreferences;
  onTerminalPreferencesChange: (value: TerminalPreferences) => void;
  onDisconnect?: () => void;
}

export function SettingsSection(props: SettingsSectionProps) {
  const [backgroundBusy, setBackgroundBusy] = useState(false);
  const { t } = useTranslation();

  const chooseBackground = async () => {
    setBackgroundBusy(true);
    try {
      const uri = await selectTerminalBackgroundImage(props.terminalPreferences.backgroundImageUri);
      if (uri) props.onTerminalPreferencesChange({ ...props.terminalPreferences, backgroundImageUri: uri });
    } catch (error) {
      Alert.alert(t('settings.imageError'), String(error));
    } finally {
      setBackgroundBusy(false);
    }
  };

  const removeBackground = async () => {
    setBackgroundBusy(true);
    try {
      await removeTerminalBackgroundImage(props.terminalPreferences.backgroundImageUri);
      props.onTerminalPreferencesChange({ ...props.terminalPreferences, backgroundImageUri: null });
    } catch (error) {
      Alert.alert(t('settings.removeImageError'), String(error));
    } finally {
      setBackgroundBusy(false);
    }
  };

  return (
    <View className="px-4 py-5">
        <Text className="text-[22px] font-semibold leading-7">{t('settings.title')}</Text>
        <View className="mb-7 mt-4 rounded-lg bg-muted p-4"><Text className="text-base font-semibold leading-6">{props.host || t('common.notConnected')}</Text><Text className="mt-1 text-sm leading-[21px] text-muted-foreground">{props.host ? t('settings.connectedCopy') : t('settings.disconnectedCopy')}</Text></View>

        <Text className="mb-3 px-1 text-sm font-semibold text-muted-foreground">{t('settings.notifications')}</Text>
        <View className="overflow-hidden rounded-lg border border-border bg-card">
          <SettingRow title={t('settings.agentNotifications')} copy={t('settings.agentNotificationsCopy')} value={props.alertsEnabled} onChange={props.onAlertsChange} />
          <SettingRow title={t('settings.speakChanges')} copy={t('settings.speakChangesCopy')} value={props.ttsEnabled} onChange={props.onTtsChange} divided />
        </View>

        <Text className="mb-3 mt-7 px-1 text-sm font-semibold text-muted-foreground">{t('settings.security')}</Text>
        <View className="overflow-hidden rounded-lg border border-border bg-card">
          <ActionRow
            title={t('settings.globalKeychain')}
            copy={t('settings.globalKeychainCopy', { count: props.globalKeyCount })}
            onPress={props.onManageGlobalKeychain}
          />
          <SettingRow title={t('settings.biometricForKeys')} copy={t('settings.biometricForKeysCopy')} value={props.biometricForKeys} onChange={props.onBiometricForKeysChange} divided />
          <SettingRow title={t('settings.biometricOnResume')} copy={t('settings.biometricOnResumeCopy')} value={props.biometricOnResume} onChange={props.onBiometricOnResumeChange} divided />
        </View>

        <Text className="mb-3 mt-7 px-1 text-sm font-semibold text-muted-foreground">{t('settings.appearance')}</Text>
        <View className="gap-3">
          <AppearanceRow value={props.appearance} onChange={props.onAppearanceChange} />
          <LanguageRow value={props.language} onChange={props.onLanguageChange} />
        </View>

        <Text className="mb-3 mt-7 px-1 text-sm font-semibold text-muted-foreground">{t('settings.terminal')}</Text>
        <View className="overflow-hidden rounded-lg border border-border bg-card">
          <SettingRow title={t('settings.keepScreenOn')} copy={t('settings.keepScreenOnCopy')} value={props.keepScreenOn} onChange={props.onKeepScreenOnChange} />
          <SettingRow title={t('settings.reopenTerminal')} copy={t('settings.reopenTerminalCopy')} value={props.reopenTerminalOnLaunch} onChange={props.onReopenTerminalOnLaunchChange} divided />
          <SettingRow title={t('settings.doubleTapTab')} copy={t('settings.doubleTapTabCopy')} value={props.terminalPreferences.doubleTapTab} onChange={value => props.onTerminalPreferencesChange({ ...props.terminalPreferences, doubleTapTab: value })} divided />
          <ValueRow title={t('settings.fontSize')} value={`${props.terminalPreferences.fontSize}px`} onDecrease={() => props.onTerminalPreferencesChange({ ...props.terminalPreferences, fontSize: Math.max(8, props.terminalPreferences.fontSize - 1) })} onIncrease={() => props.onTerminalPreferencesChange({ ...props.terminalPreferences, fontSize: Math.min(24, props.terminalPreferences.fontSize + 1) })} divided />
          <ValueRow title={t('settings.scrollback')} value={t('settings.lines', { count: props.terminalPreferences.scrollback })} onDecrease={() => props.onTerminalPreferencesChange({ ...props.terminalPreferences, scrollback: Math.max(1000, props.terminalPreferences.scrollback - 1000) })} onIncrease={() => props.onTerminalPreferencesChange({ ...props.terminalPreferences, scrollback: Math.min(20000, props.terminalPreferences.scrollback + 1000) })} divided />
          <SettingRow title={t('settings.blinkingCursor')} copy={t('settings.blinkingCursorCopy')} value={props.terminalPreferences.cursorBlink} onChange={value => props.onTerminalPreferencesChange({ ...props.terminalPreferences, cursorBlink: value })} divided />
          <TerminalBackgroundRow
            busy={backgroundBusy}
            uri={props.terminalPreferences.backgroundImageUri}
            dimming={props.terminalPreferences.backgroundDimming}
            onChoose={chooseBackground}
            onRemove={removeBackground}
          />
          <ValueRow
            title={t('settings.backgroundDimming')}
            value={`${props.terminalPreferences.backgroundDimming}%`}
            disabled={!props.terminalPreferences.backgroundImageUri}
            onDecrease={() => props.onTerminalPreferencesChange({ ...props.terminalPreferences, backgroundDimming: Math.max(0, props.terminalPreferences.backgroundDimming - 5) })}
            onIncrease={() => props.onTerminalPreferencesChange({ ...props.terminalPreferences, backgroundDimming: Math.min(100, props.terminalPreferences.backgroundDimming + 5) })}
            divided
          />
        </View>

        <View className="mt-7 flex-row items-start gap-3 rounded-lg bg-muted p-4"><Icon as={ShieldCheck} size={21} /><View className="flex-1"><Text className="text-sm font-semibold leading-[19px]">{t('settings.privateBoundary')}</Text><Text className="mt-1 text-xs leading-[18px] text-muted-foreground">{t('settings.privateBoundaryCopy')}</Text></View></View>

        {props.onDisconnect ? <Button className="mt-6 rounded-full" variant="destructive" onPress={hapticPress(props.onDisconnect)}><Icon as={LogOut} className="text-destructive-foreground" size={17} /><Text>{t('settings.disconnect')}</Text></Button> : null}
      </View>
  );
}

const appearanceOptions: { labelKey: string; value: AppearancePreference }[] = [
  { labelKey: 'settings.system', value: 'system' },
  { labelKey: 'settings.light', value: 'light' },
  { labelKey: 'settings.dark', value: 'dark' },
];

function AppearanceRow({ value, onChange }: { value: AppearancePreference; onChange: (value: AppearancePreference) => void }) {
  const { t } = useTranslation();
  return (
    <View className="rounded-lg border border-border bg-card p-3.5">
      <Text className="text-[15px] font-semibold leading-5">{t('settings.colorTheme')}</Text>
      <Text className="mt-0.5 text-xs leading-[17px] text-muted-foreground">{t('settings.colorThemeCopy')}</Text>
      <View className="mt-3 flex-row gap-2">
        {appearanceOptions.map(option => {
          const selected = option.value === value;
          return (
            <Button
              key={option.value}
              className="flex-1 rounded-full"
              variant={selected ? 'default' : 'outline'}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={hapticPress(() => onChange(option.value))}
            >
              <Text>{t(option.labelKey)}</Text>
            </Button>
          );
        })}
      </View>
    </View>
  );
}

const languageOptions: { labelKey: string; value: LanguagePreference }[] = [
  { labelKey: 'settings.automatic', value: 'system' },
  { labelKey: 'settings.english', value: 'en' },
  { labelKey: 'settings.traditionalChinese', value: 'zh-Hant' },
];

function LanguageRow({ value, onChange }: { value: LanguagePreference; onChange: (value: LanguagePreference) => void }) {
  const { t } = useTranslation();
  return (
    <View className="rounded-lg border border-border bg-card p-3.5">
      <Text className="text-[15px] font-semibold leading-5">{t('settings.language')}</Text>
      <Text className="mt-0.5 text-xs leading-[17px] text-muted-foreground">{t('settings.languageCopy')}</Text>
      <View className="mt-3 flex-row gap-2">
        {languageOptions.map(option => {
          const selected = option.value === value;
          return (
            <Button
              key={option.value}
              className="min-w-0 flex-1 rounded-full px-2"
              variant={selected ? 'default' : 'outline'}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={hapticPress(() => onChange(option.value))}>
              <Text className="text-center text-xs" numberOfLines={1}>{t(option.labelKey)}</Text>
            </Button>
          );
        })}
      </View>
    </View>
  );
}

function ValueRow({ title, value, onDecrease, onIncrease, divided = false, disabled = false }: { title: string; value: string; onDecrease: () => void; onIncrease: () => void; divided?: boolean; disabled?: boolean }) {
  const { t } = useTranslation();
  return <View className={divided ? 'min-h-16 flex-row items-center border-t border-border px-3.5' : 'min-h-16 flex-row items-center px-3.5'}><Text className="text-[15px] font-semibold leading-5">{title}</Text><View className="ml-auto flex-row items-center"><IconButton icon={Minus} accessibilityLabel={t('settings.decrease', { name: title })} className="size-9" disabled={disabled} onPress={onDecrease} /><Text className={disabled ? 'min-w-[92px] text-center text-xs text-muted-foreground/50' : 'min-w-[92px] text-center text-xs text-muted-foreground'}>{value}</Text><IconButton icon={Plus} accessibilityLabel={t('settings.increase', { name: title })} className="size-9" disabled={disabled} onPress={onIncrease} /></View></View>;
}

function TerminalBackgroundRow({ busy, uri, dimming, onChoose, onRemove }: { busy: boolean; uri: string | null; dimming: number; onChoose: () => Promise<void>; onRemove: () => Promise<void> }) {
  const { t } = useTranslation();
  return (
    <View className="border-t border-border p-3.5">
      <View className="mb-3"><Text className="text-[15px] font-semibold leading-5">{t('settings.backgroundImage')}</Text><Text className="mt-0.5 text-xs leading-[17px] text-muted-foreground">{t('settings.backgroundImageCopy')}</Text></View>
      <View className="relative h-28 overflow-hidden rounded-md bg-[#212121]">
        {uri ? <Image source={{ uri }} resizeMode="cover" fadeDuration={180} className="absolute inset-0 size-full" /> : null}
        {uri ? <View className="absolute inset-0" style={{ backgroundColor: `rgba(24, 24, 24, ${dimming / 100})` }} /> : null}
        <View className="absolute inset-0 justify-end p-3"><Text style={styles.terminalPreviewText} className="text-xs text-white">user@host:~ $ herdr status</Text><Text style={styles.terminalPreviewText} className="mt-1 text-[10px] text-[#B4B4B4]">{t('settings.terminalPreview')}</Text></View>
      </View>
      <View className="mt-3 flex-row gap-2">
        <Button className="flex-1 rounded-full" variant="secondary" disabled={busy} onPress={hapticPress(onChoose)}><Icon as={ImagePlus} size={16} /><Text>{uri ? t('settings.replaceImage') : t('settings.chooseImage')}</Text></Button>
        {uri ? <Button className="rounded-full px-4" variant="ghost" disabled={busy} onPress={hapticPress(onRemove)}><Icon as={Trash2} className="text-destructive" size={16} /><Text className="text-destructive">{t('common.remove')}</Text></Button> : null}
      </View>
    </View>
  );
}

function SettingRow({ title, copy, value, onChange, divided = false }: { title: string; copy: string; value: boolean; onChange: (value: boolean) => void; divided?: boolean }) {
  return <View className={divided ? 'min-h-[82px] flex-row items-center border-t border-border p-3.5' : 'min-h-[82px] flex-row items-center p-3.5'}><View className="flex-1 pr-[18px]"><Text className="text-[15px] font-semibold leading-5">{title}</Text><Text className="mt-0.5 text-xs leading-[17px] text-muted-foreground">{copy}</Text></View><Switch checked={value} onCheckedChange={onChange} /></View>;
}

function ActionRow({ title, copy, onPress }: { title: string; copy: string; onPress: () => void }) {
  return (
    <Button className="min-h-[82px] justify-start rounded-none px-3.5 py-3" size="content" variant="ghost" onPress={hapticPress(onPress)}>
      <View className="size-10 items-center justify-center rounded-full bg-primary/10"><Icon as={KeyRound} className="text-primary" size={18} /></View>
      <View className="ml-3 min-w-0 flex-1"><Text className="text-[15px] font-semibold leading-5">{title}</Text><Text className="mt-0.5 text-xs leading-[17px] text-muted-foreground">{copy}</Text></View>
      <Icon as={ChevronRight} className="text-muted-foreground" size={18} />
    </Button>
  );
}

const styles = StyleSheet.create({
  terminalPreviewText: { fontFamily: 'monospace' },
});
