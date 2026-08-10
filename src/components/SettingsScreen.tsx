import { BellRing, Check, ChevronDown, ChevronRight, ChevronUp, Fingerprint, History, ImagePlus, Info, KeyRound, Minus, Plus, Trash2, X, type LucideIcon } from 'lucide-react-native';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Clipboard, Image, Modal, Platform, Pressable, ScrollView, StyleSheet, ToastAndroid, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import {
  terminalDoubleTapActions,
  type TerminalDoubleTapAction,
} from '@/src/lib/terminalDoubleTap';
import { deviceLanguage, type SupportedLanguage } from '@/src/i18n';
import { terminalFontFamily } from '@/src/lib/terminalFonts';
import {
  MIN_XTERM_CACHE_CAPACITY,
} from '@/src/lib/terminalRendererLru';
import { cn } from '@/src/lib/utils';
import {
  terminalVolumeKeyActions,
  type TerminalVolumeKey,
  type TerminalVolumeKeyAction,
} from '@/src/lib/volumeKeys';
import {
  MAX_PERSISTENT_ALERT_DURATION_SECONDS,
  MIN_PERSISTENT_ALERT_DURATION_SECONDS,
  PERSISTENT_ALERT_DURATION_STEP_SECONDS,
  type AppearancePreference,
  type LanguagePreference,
  type TerminalPreferences,
} from '@/src/services/devicePreferences';
import { removeAppBackgroundImage, selectAppBackgroundImage } from '@/src/services/appBackground';
import { openNotificationSettings } from '@/src/services/notificationSettings';
import { removeTerminalBackgroundImage, selectTerminalBackgroundImage } from '@/src/services/terminalBackground';
import { hapticPress, IconButton } from './app-ui';
import { GlassSurface } from './GlassSurface';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import { Text } from './ui/text';

const DOUBLE_TAP_MENU_EXPAND_DURATION = 280;
const DOUBLE_TAP_MENU_COLLAPSE_DURATION = 220;

const SettingsDetailsContext = createContext<{ showDetails: (copy: string, y: number) => void }>({
  showDetails: (_copy: string, _y: number) => undefined,
});

export function SettingsDetailsProvider({ children }: { children: ReactNode }) {
  const [activeDetails, setActiveDetails] = useState<{
    copy: string;
    anchorY: number;
    containerHeight: number;
  } | null>(null);
  const containerRef = useRef<View>(null);
  const showDetails = (copy: string, y: number) => {
    containerRef.current?.measureInWindow((_x, containerY, _width, containerHeight) => {
      setActiveDetails({
        copy,
        anchorY: y - containerY,
        containerHeight,
      });
    });
  };
  const tooltipPosition = {
    bottom: activeDetails
      ? Math.max(12, activeDetails.containerHeight - activeDetails.anchorY + 8)
      : 12,
  };
  return (
    <SettingsDetailsContext.Provider value={{ showDetails }}>
      <View ref={containerRef} className="flex-1" onTouchStart={() => setActiveDetails(null)}>
        {children}
        {activeDetails ? (
          <View pointerEvents="none" className="absolute inset-0">
            <View
              className="absolute left-5 right-5 rounded-xl border border-border bg-foreground/70 px-4 py-3"
              style={[styles.detailsTooltip, tooltipPosition]}>
              <Text accessibilityLiveRegion="polite" className="text-sm leading-5 text-background">
                {activeDetails.copy}
              </Text>
            </View>
          </View>
        ) : null}
      </View>
    </SettingsDetailsContext.Provider>
  );
}

export interface SettingsSectionProps {
  alertsEnabled: boolean;
  persistentAlertDurationSeconds: number;
  ttsEnabled: boolean;
  biometricForKeys: boolean;
  biometricOnResume: boolean;
  globalKeyCount: number;
  knownHostCount: number;
  appearance: AppearancePreference;
  fullscreenApp: boolean;
  appBackgroundImageUri: string | null;
  appBackgroundDimming: number;
  appGlassEnabled: boolean;
  language: LanguagePreference;
  keepScreenOn: boolean;
  reopenTerminalOnLaunch: boolean;
  agentCommand: string;
  terminalHistory: readonly string[];
  onAlertsChange: (value: boolean) => void;
  onPersistentAlertDurationChange: (value: number) => void;
  onTtsChange: (value: boolean) => void;
  onBiometricForKeysChange: (value: boolean) => void;
  onBiometricOnResumeChange: (value: boolean) => void;
  onManageGlobalKeychain: () => void;
  onManageKnownHosts: () => void;
  onAppearanceChange: (value: AppearancePreference) => void;
  onFullscreenAppChange: (value: boolean) => void;
  onAppBackgroundImageChange: (value: string | null) => void;
  onAppBackgroundDimmingChange: (value: number) => void;
  onAppGlassEnabledChange: (value: boolean) => void;
  onLanguageChange: (value: LanguagePreference) => void;
  onKeepScreenOnChange: (value: boolean) => void;
  onReopenTerminalOnLaunchChange: (value: boolean) => void;
  onAgentCommandChange: (value: string) => void;
  onDeleteTerminalHistory: (entries: readonly string[]) => void;
  terminalPreferences: TerminalPreferences;
  onTerminalPreferencesChange: (value: TerminalPreferences) => void;
}

export function SettingsSection(props: SettingsSectionProps) {
  const [appBackgroundBusy, setAppBackgroundBusy] = useState(false);
  const [terminalBackgroundBusy, setTerminalBackgroundBusy] = useState(false);
  const [doubleTapExpanded, setDoubleTapExpanded] = useState(false);
  const [volumeKeyEditor, setVolumeKeyEditor] = useState<TerminalVolumeKey | null>(null);
  const [historyManagerOpen, setHistoryManagerOpen] = useState(false);
  const { t } = useTranslation();

  const chooseBackground = async () => {
    setTerminalBackgroundBusy(true);
    try {
      const uri = await selectTerminalBackgroundImage(props.terminalPreferences.backgroundImageUri);
      if (uri) props.onTerminalPreferencesChange({ ...props.terminalPreferences, backgroundImageUri: uri });
    } catch (error) {
      Alert.alert(t('settings.imageError'), String(error));
    } finally {
      setTerminalBackgroundBusy(false);
    }
  };

  const removeBackground = async () => {
    setTerminalBackgroundBusy(true);
    try {
      await removeTerminalBackgroundImage(props.terminalPreferences.backgroundImageUri);
      props.onTerminalPreferencesChange({ ...props.terminalPreferences, backgroundImageUri: null });
    } catch (error) {
      Alert.alert(t('settings.removeImageError'), String(error));
    } finally {
      setTerminalBackgroundBusy(false);
    }
  };

  const chooseAppBackground = async () => {
    setAppBackgroundBusy(true);
    try {
      const uri = await selectAppBackgroundImage(props.appBackgroundImageUri);
      if (uri) props.onAppBackgroundImageChange(uri);
    } catch (error) {
      Alert.alert(t('settings.imageError'), String(error));
    } finally {
      setAppBackgroundBusy(false);
    }
  };

  const removeAppBackground = async () => {
    setAppBackgroundBusy(true);
    try {
      await removeAppBackgroundImage(props.appBackgroundImageUri);
      props.onAppBackgroundImageChange(null);
    } catch (error) {
      Alert.alert(t('settings.removeImageError'), String(error));
    } finally {
      setAppBackgroundBusy(false);
    }
  };

  const changeNotificationSettings = async () => {
    try {
      await openNotificationSettings();
    } catch (error) {
      Alert.alert(t('settings.notificationSettingsError'), String(error));
    }
  };

  return (
    <View className="px-4 py-5">
        <Text className="text-[22px] font-semibold leading-7">{t('settings.title')}</Text>
        <Text className="mb-3 mt-4 px-1 text-sm font-semibold text-muted-foreground">{t('settings.notifications')}</Text>
        <GlassSurface className="rounded-lg border border-white/30 dark:border-white/10">
          <SettingRow title={t('settings.agentNotifications')} copy={t('settings.agentNotificationsCopy')} value={props.alertsEnabled} onChange={props.onAlertsChange} />
          <ValueRow
            title={t('settings.backgroundAlertDuration')}
            copy={t('settings.backgroundAlertDurationCopy')}
            value={t('settings.seconds', { count: props.persistentAlertDurationSeconds })}
            disabled={!props.alertsEnabled}
            onDecrease={() => props.onPersistentAlertDurationChange(Math.max(
              MIN_PERSISTENT_ALERT_DURATION_SECONDS,
              props.persistentAlertDurationSeconds - PERSISTENT_ALERT_DURATION_STEP_SECONDS,
            ))}
            onIncrease={() => props.onPersistentAlertDurationChange(Math.min(
              MAX_PERSISTENT_ALERT_DURATION_SECONDS,
              props.persistentAlertDurationSeconds + PERSISTENT_ALERT_DURATION_STEP_SECONDS,
            ))}
            divided
          />
          <SettingRow title={t('settings.speakChanges')} copy={t('settings.speakChangesCopy')} value={props.ttsEnabled} onChange={props.onTtsChange} divided />
          <ActionRow
            title={t('settings.changeNotificationSettings')}
            copy={t('settings.changeNotificationSettingsCopy')}
            icon={BellRing}
            onPress={changeNotificationSettings}
            divided
          />
        </GlassSurface>

        <Text className="mb-3 mt-7 px-1 text-sm font-semibold text-muted-foreground">{t('settings.security')}</Text>
        <GlassSurface className="rounded-lg border border-white/30 dark:border-white/10">
          <ActionRow
            title={t('settings.globalKeychain')}
            copy={t('settings.globalKeychainCopy', { count: props.globalKeyCount })}
            icon={KeyRound}
            onPress={props.onManageGlobalKeychain}
          />
          <ActionRow
            title={t('settings.knownHosts')}
            copy={t('settings.knownHostsCopy', { count: props.knownHostCount })}
            icon={Fingerprint}
            onPress={props.onManageKnownHosts}
            divided
          />
          <SettingRow title={t('settings.biometricForKeys')} copy={t('settings.biometricForKeysCopy')} value={props.biometricForKeys} onChange={props.onBiometricForKeysChange} divided />
          <SettingRow title={t('settings.biometricOnResume')} copy={t('settings.biometricOnResumeCopy')} value={props.biometricOnResume} onChange={props.onBiometricOnResumeChange} divided />
        </GlassSurface>

        <Text className="mb-3 mt-7 px-1 text-sm font-semibold text-muted-foreground">{t('settings.appearance')}</Text>
        <View className="gap-3">
          <AppearanceRow value={props.appearance} onChange={props.onAppearanceChange} />
          <GlassSurface className="rounded-lg border border-white/30 dark:border-white/10">
            <SettingRow
              title={t('settings.fullscreenApp')}
              copy={t('settings.fullscreenAppCopy')}
              value={props.fullscreenApp}
              onChange={props.onFullscreenAppChange}
            />
          </GlassSurface>
          <GlassSurface className="rounded-lg border border-white/30 dark:border-white/10">
            <AppBackgroundRow
              busy={appBackgroundBusy}
              uri={props.appBackgroundImageUri}
              dimming={props.appBackgroundDimming}
              onChoose={chooseAppBackground}
              onRemove={removeAppBackground}
            />
            <ValueRow
              title={t('settings.backgroundDimming')}
              value={`${props.appBackgroundDimming}%`}
              disabled={!props.appBackgroundImageUri}
              onDecrease={() => props.onAppBackgroundDimmingChange(Math.max(0, props.appBackgroundDimming - 5))}
              onIncrease={() => props.onAppBackgroundDimmingChange(Math.min(100, props.appBackgroundDimming + 5))}
              divided
            />
            <SettingRow
              title={t('settings.experimentalGlass')}
              copy={props.appBackgroundImageUri
                ? t('settings.experimentalGlassCopy')
                : t('settings.experimentalGlassRequiresImage')}
              value={props.appGlassEnabled}
              disabled={!props.appBackgroundImageUri}
              onChange={props.onAppGlassEnabledChange}
              divided
            />
          </GlassSurface>
          <LanguageRow value={props.language} onChange={props.onLanguageChange} />
        </View>

        <Text className="mb-3 mt-7 px-1 text-sm font-semibold text-muted-foreground">{t('settings.herd')}</Text>
        <GlassSurface className="rounded-lg border border-white/30 dark:border-white/10">
          <View className="p-3.5">
            <DetailsTitle
              title={t('settings.agentCommand')}
              copy={t('settings.agentCommandCopy')}
            />
            <Input
              className="mt-3 font-mono"
              value={props.agentCommand}
              onChangeText={props.onAgentCommandChange}
              placeholder="opencode"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        </GlassSurface>

        <Text className="mb-3 mt-7 px-1 text-sm font-semibold text-muted-foreground">{t('settings.terminal')}</Text>
        <GlassSurface className="rounded-lg border border-white/30 dark:border-white/10">
          <SettingRow title={t('settings.fullscreenTerminal')} copy={t('settings.fullscreenTerminalCopy')} value={props.terminalPreferences.fullscreen} onChange={value => props.onTerminalPreferencesChange({ ...props.terminalPreferences, fullscreen: value })} />
          <SettingRow title={t('settings.keepScreenOn')} copy={t('settings.keepScreenOnCopy')} value={props.keepScreenOn} onChange={props.onKeepScreenOnChange} divided />
          <SettingRow title={t('settings.reopenTerminal')} copy={t('settings.reopenTerminalCopy')} value={props.reopenTerminalOnLaunch} onChange={props.onReopenTerminalOnLaunchChange} divided />
          <SettingRow title={t('settings.useModifierKeyIcons')} copy={t('settings.useModifierKeyIconsCopy')} value={props.terminalPreferences.useModifierKeyIcons} onChange={value => props.onTerminalPreferencesChange({ ...props.terminalPreferences, useModifierKeyIcons: value })} divided />
          <ActionRow
            title={t('settings.terminalHistory')}
            copy={t('settings.terminalHistoryCopy')}
            icon={History}
            value={t('settings.terminalHistoryCount', { count: props.terminalHistory.length })}
            onPress={() => setHistoryManagerOpen(true)}
            divided
          />
          <ChoiceRow
            title={t('settings.volumeUpKey')}
            copy={t('settings.volumeKeyCopy')}
            value={t(volumeKeyActionLabelKey('up', props.terminalPreferences.volumeUpAction))}
            onPress={() => setVolumeKeyEditor('up')}
            divided
          />
          <ChoiceRow
            title={t('settings.volumeDownKey')}
            copy={t('settings.volumeKeyCopy')}
            value={t(volumeKeyActionLabelKey('down', props.terminalPreferences.volumeDownAction))}
            onPress={() => setVolumeKeyEditor('down')}
            divided
          />
          <DoubleTapActionMenu
            expanded={doubleTapExpanded}
            value={props.terminalPreferences.doubleTapAction}
            onToggle={() => {
              setDoubleTapExpanded(expanded => !expanded);
            }}
            onSelect={action => {
              props.onTerminalPreferencesChange({ ...props.terminalPreferences, doubleTapAction: action });
              setDoubleTapExpanded(false);
            }}
            divided
          />
          <SettingRow title={t('settings.pauseResizeInBackground')} copy={t('settings.pauseResizeInBackgroundCopy')} value={props.terminalPreferences.pauseResizeInBackground} onChange={value => props.onTerminalPreferencesChange({ ...props.terminalPreferences, pauseResizeInBackground: value })} divided />
          <ValueRow title={t('settings.fontSize')} value={`${props.terminalPreferences.fontSize}px`} onDecrease={() => props.onTerminalPreferencesChange({ ...props.terminalPreferences, fontSize: Math.max(8, props.terminalPreferences.fontSize - 1) })} onIncrease={() => props.onTerminalPreferencesChange({ ...props.terminalPreferences, fontSize: Math.min(24, props.terminalPreferences.fontSize + 1) })} divided />
          <ValueRow title={t('settings.scrollback')} value={t('settings.lines', { count: props.terminalPreferences.scrollback })} onDecrease={() => props.onTerminalPreferencesChange({ ...props.terminalPreferences, scrollback: Math.max(1000, props.terminalPreferences.scrollback - 1000) })} onIncrease={() => props.onTerminalPreferencesChange({ ...props.terminalPreferences, scrollback: Math.min(20000, props.terminalPreferences.scrollback + 1000) })} divided />
          <XtermCacheCapacityRow value={props.terminalPreferences.xtermCacheCapacity} onChange={value => props.onTerminalPreferencesChange({ ...props.terminalPreferences, xtermCacheCapacity: value })} />
          <SettingRow title={t('settings.blinkingCursor')} copy={t('settings.blinkingCursorCopy')} value={props.terminalPreferences.cursorBlink} onChange={value => props.onTerminalPreferencesChange({ ...props.terminalPreferences, cursorBlink: value })} divided />
          <TerminalBackgroundRow
            busy={terminalBackgroundBusy}
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
        </GlassSurface>

        <VolumeKeyActionSheet
          keyName={volumeKeyEditor}
          value={volumeKeyEditor === 'down'
            ? props.terminalPreferences.volumeDownAction
            : props.terminalPreferences.volumeUpAction}
          onClose={() => setVolumeKeyEditor(null)}
          onSelect={action => {
            props.onTerminalPreferencesChange(volumeKeyEditor === 'down'
              ? { ...props.terminalPreferences, volumeDownAction: action }
              : { ...props.terminalPreferences, volumeUpAction: action });
            setVolumeKeyEditor(null);
          }}
        />
        <TerminalHistoryManager
          entries={props.terminalHistory}
          visible={historyManagerOpen}
          onClose={() => setHistoryManagerOpen(false)}
          onDelete={props.onDeleteTerminalHistory}
        />
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
    <GlassSurface className="rounded-lg border border-white/30 p-3.5 dark:border-white/10">
      <DetailsTitle
        title={t('settings.colorTheme')}
        copy={t('settings.colorThemeCopy')}
      />
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
    </GlassSurface>
  );
}

const languageOptions: { labelKey: string; value: LanguagePreference }[] = [
  { labelKey: 'settings.automatic', value: 'system' },
  { labelKey: 'settings.english', value: 'en' },
  { labelKey: 'settings.traditionalChinese', value: 'zh-Hant' },
  { labelKey: 'settings.simplifiedChinese', value: 'zh-Hans' },
  { labelKey: 'settings.japanese', value: 'ja' },
  { labelKey: 'settings.spanish', value: 'es' },
];

function LanguageRow({ value, onChange }: { value: LanguagePreference; onChange: (value: LanguagePreference) => void }) {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation();
  const selectedOption = languageOptions.find(option => option.value === value) || languageOptions[0];
  const systemOption = languageOptions.find(option => option.value === deviceLanguage()) || languageOptions[1];
  const selectedLabel = value === 'system'
    ? t('settings.systemLanguage', { language: t(systemOption.labelKey) })
    : t(selectedOption.labelKey);
  return (
    <>
      <GlassSurface className="rounded-lg border border-white/30 dark:border-white/10">
        <Button
          accessibilityState={{ expanded: open }}
          className="min-h-[72px] justify-start rounded-none px-3.5 py-2.5"
          size="content"
          variant="ghost"
          onPress={hapticPress(() => setOpen(true))}>
          <View className="min-w-0 flex-1 pr-3">
            <DetailsTitle title={t('settings.language')} copy={t('settings.languageCopy')} />
          </View>
          <Text className="max-w-[150px] text-right text-xs font-semibold text-primary" numberOfLines={2}>{selectedLabel}</Text>
          <Icon as={ChevronRight} className="text-muted-foreground" size={18} />
        </Button>
      </GlassSurface>
      <LanguageSelectionSheet
        value={value}
        visible={open}
        onClose={() => setOpen(false)}
        onSelect={next => {
          onChange(next);
          setOpen(false);
        }}
      />
    </>
  );
}

function LanguageSelectionSheet({ value, visible, onClose, onSelect }: { value: LanguagePreference; visible: boolean; onClose: () => void; onSelect: (value: LanguagePreference) => void }) {
  const { bottom } = useSafeAreaInsets();
  const { t } = useTranslation();
  const systemLanguage = deviceLanguage() as SupportedLanguage;
  const systemOption = languageOptions.find(option => option.value === systemLanguage) || languageOptions[1];
  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <View className="flex-1 justify-end">
        <Pressable accessibilityLabel={t('common.close')} className="absolute inset-0 bg-black/55" onPress={onClose} />
        <GlassSurface
          className="rounded-t-[22px] border-t border-white/30 px-4 pt-4 dark:border-white/10"
          style={{ paddingBottom: Math.max(16, bottom) }}>
          <View className="mb-1 flex-row items-center">
            <Text className="min-w-0 flex-1 text-[18px] font-semibold">{t('settings.language')}</Text>
            <IconButton icon={X} accessibilityLabel={t('common.close')} onPress={onClose} />
          </View>
          <View className="mt-3 overflow-hidden rounded-lg border border-border">
            {languageOptions.map((option, index) => {
              const selected = option.value === value;
              return (
                <Button
                  key={option.value}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  className={cn(
                    'min-h-[52px] justify-start rounded-none px-3.5',
                    index > 0 && 'border-t border-border',
                    selected && 'bg-primary/10',
                  )}
                  size="content"
                  variant="ghost"
                  onPress={hapticPress(() => onSelect(option.value))}>
                  <View className="min-w-0 flex-1">
                    <Text className={cn('text-sm font-medium', selected && 'text-primary')}>{t(option.labelKey)}</Text>
                    {option.value === 'system' ? (
                      <Text className="mt-0.5 text-[11px] text-muted-foreground">
                        {t('settings.systemLanguage', { language: t(systemOption.labelKey) })}
                      </Text>
                    ) : null}
                  </View>
                  {selected ? <Icon as={Check} className="text-primary" size={18} /> : null}
                </Button>
              );
            })}
          </View>
        </GlassSurface>
      </View>
    </Modal>
  );
}

function ValueRow({ title, copy, value, onDecrease, onIncrease, divided = false, disabled = false }: { title: string; copy?: string; value: string; onDecrease: () => void; onIncrease: () => void; divided?: boolean; disabled?: boolean }) {
  const { t } = useTranslation();
  const rowClassName = divided
    ? 'min-h-16 flex-row items-center border-t border-border px-3.5 py-2'
    : 'min-h-16 flex-row items-center px-3.5 py-2';
  return <View className={rowClassName}><View className="min-w-0 flex-1 pr-2">{copy ? <DetailsTitle title={title} copy={copy} /> : <Text className="text-[15px] font-semibold leading-5">{title}</Text>}</View><View className="flex-row items-center"><IconButton icon={Minus} accessibilityLabel={t('settings.decrease', { name: title })} className="size-9" disabled={disabled} onPress={onDecrease} /><Text className={disabled ? 'min-w-[64px] text-center text-xs text-muted-foreground/50' : 'min-w-[64px] text-center text-xs text-muted-foreground'}>{value}</Text><IconButton icon={Plus} accessibilityLabel={t('settings.increase', { name: title })} className="size-9" disabled={disabled} onPress={onIncrease} /></View></View>;
}

function XtermCacheCapacityRow({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (Number.isSafeInteger(parsed) && parsed >= MIN_XTERM_CACHE_CAPACITY) {
      onChange(parsed);
      setDraft(String(parsed));
      return;
    }
    setDraft(String(value));
  };
  return (
    <View className="min-h-16 flex-row items-center border-t border-border px-3.5 py-2">
      <View className="min-w-0 flex-1 pr-3">
        <DetailsTitle title={t('settings.cachedTerminals')} copy={t('settings.cachedTerminalsCopy')} />
      </View>
      <Input
        accessibilityLabel={t('settings.cachedTerminals')}
        className="h-10 w-20 text-center font-mono"
        inputMode="numeric"
        keyboardType="number-pad"
        selectTextOnFocus
        value={draft}
        onBlur={commit}
        onChangeText={text => setDraft(text.replace(/[^0-9]/g, ''))}
        onSubmitEditing={commit}
      />
    </View>
  );
}

function ChoiceRow({ title, copy, value, onPress, divided = false }: { title: string; copy: string; value: string; onPress: () => void; divided?: boolean }) {
  return (
    <Button className={divided ? 'min-h-16 justify-start rounded-none border-t border-border px-3.5 py-2' : 'min-h-16 justify-start rounded-none px-3.5 py-2'} size="content" variant="ghost" onPress={hapticPress(onPress)}>
      <View className="min-w-0 flex-1 pr-3"><DetailsTitle title={title} copy={copy} /></View>
      <Text className="max-w-[130px] text-right text-xs font-semibold text-primary">{value}</Text>
      <Icon as={ChevronRight} className="ml-1 text-muted-foreground" size={18} />
    </Button>
  );
}

function volumeKeyActionLabelKey(key: TerminalVolumeKey, action: TerminalVolumeKeyAction): string {
  return `settings.volumeKeyAction.${key}.${action}`;
}

function doubleTapActionLabelKey(action: TerminalDoubleTapAction): string {
  return `settings.doubleTapAction.${action}`;
}

function DoubleTapActionMenu({ expanded, value, onToggle, onSelect, divided = false }: { expanded: boolean; value: TerminalDoubleTapAction; onToggle: () => void; onSelect: (action: TerminalDoubleTapAction) => void; divided?: boolean }) {
  const { t } = useTranslation();
  const [contentMounted, setContentMounted] = useState(expanded);
  const [contentMeasured, setContentMeasured] = useState(false);
  const contentHeight = useSharedValue(0);
  const progress = useSharedValue(expanded ? 1 : 0);

  useEffect(() => {
    cancelAnimation(progress);
    if (expanded && !contentMeasured) {
      progress.value = 0;
      return;
    }
    progress.value = withTiming(expanded ? 1 : 0, {
      duration: expanded ? DOUBLE_TAP_MENU_EXPAND_DURATION : DOUBLE_TAP_MENU_COLLAPSE_DURATION,
      easing: Easing.inOut(Easing.cubic),
    });
    return () => cancelAnimation(progress);
  }, [contentMeasured, expanded, progress]);

  const collapsibleStyle = useAnimatedStyle(() => ({
    height: contentHeight.value * progress.value,
    opacity: progress.value,
    transform: [{ translateY: -6 * (1 - progress.value) }],
  }));

  return (
    <View className={divided ? 'border-t border-border' : ''}>
      <Button
        accessibilityState={{ expanded }}
        className="min-h-16 justify-start rounded-none px-3.5 py-2"
        size="content"
        variant="ghost"
        onPress={hapticPress(() => {
          if (!expanded) setContentMounted(true);
          onToggle();
        })}>
        <View className="min-w-0 flex-1 pr-3"><DetailsTitle title={t('settings.doubleTap')} copy={t('settings.doubleTapCopy')} /></View>
        <Text className="max-w-[130px] text-right text-xs font-semibold text-primary">{t(doubleTapActionLabelKey(value))}</Text>
        <Icon as={expanded ? ChevronUp : ChevronDown} className="ml-1 text-muted-foreground" size={18} />
      </Button>
      <Animated.View
        accessibilityElementsHidden={!expanded}
        importantForAccessibility={expanded ? 'auto' : 'no-hide-descendants'}
        pointerEvents={expanded ? 'auto' : 'none'}
        className="overflow-hidden"
        style={collapsibleStyle}>
        {contentMounted ? (
          <View
            className="absolute inset-x-0 top-0 border-t border-border bg-muted/30 p-2"
            onLayout={event => {
              contentHeight.value = event.nativeEvent.layout.height;
              setContentMeasured(true);
            }}>
          <View className="overflow-hidden rounded-lg border border-border bg-card">
            {terminalDoubleTapActions.map((action, index) => {
              const selected = action === value;
              return (
                <Button
                  key={action}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  className={index === 0 ? 'min-h-12 justify-start rounded-none px-3.5' : 'min-h-12 justify-start rounded-none border-t border-border px-3.5'}
                  variant={selected ? 'secondary' : 'ghost'}
                  onPress={hapticPress(() => onSelect(action))}>
                  <Text className="flex-1 text-left text-sm font-medium">{t(doubleTapActionLabelKey(action))}</Text>
                  {selected ? <Icon as={Check} className="text-primary" size={18} /> : null}
                </Button>
              );
            })}
          </View>
          </View>
        ) : null}
      </Animated.View>
    </View>
  );
}

function VolumeKeyActionSheet({ keyName, value, onClose, onSelect }: { keyName: TerminalVolumeKey | null; value: TerminalVolumeKeyAction; onClose: () => void; onSelect: (action: TerminalVolumeKeyAction) => void }) {
  const { bottom } = useSafeAreaInsets();
  const { t } = useTranslation();
  const direction = keyName || 'up';
  return (
    <Modal animationType="slide" transparent visible={keyName !== null} onRequestClose={onClose}>
      <SettingsDetailsProvider>
        <View className="flex-1 justify-end">
          <Pressable accessibilityLabel={t('common.close')} className="absolute inset-0 bg-black/55" onPress={onClose} />
          <View className="rounded-t-[22px] border-t border-border bg-card px-4 pt-4" style={{ paddingBottom: Math.max(16, bottom) }}>
            <View className="mb-3 flex-row items-center">
              <View className="min-w-0 flex-1"><DetailsTitle title={t(direction === 'up' ? 'settings.volumeUpKey' : 'settings.volumeDownKey')} copy={t('settings.volumeKeySheetCopy')} titleClassName="text-[18px] font-semibold" /></View>
              <IconButton icon={X} accessibilityLabel={t('common.close')} onPress={onClose} />
            </View>
            <View className="overflow-hidden rounded-lg border border-border">
              {terminalVolumeKeyActions.map((action, index) => {
                const selected = action === value;
                return (
                  <Button
                    key={action}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    className={index === 0 ? 'min-h-12 justify-start rounded-none px-3.5' : 'min-h-12 justify-start rounded-none border-t border-border px-3.5'}
                    variant={selected ? 'secondary' : 'ghost'}
                    onPress={hapticPress(() => onSelect(action))}>
                    <Text className="flex-1 text-left text-sm font-medium">{t(volumeKeyActionLabelKey(direction, action))}</Text>
                    {selected ? <Icon as={Check} className="text-primary" size={18} /> : null}
                  </Button>
                );
              })}
            </View>
          </View>
        </View>
      </SettingsDetailsProvider>
    </Modal>
  );
}

function TerminalHistoryManager({
  entries,
  visible,
  onClose,
  onDelete,
}: {
  entries: readonly string[];
  visible: boolean;
  onClose: () => void;
  onDelete: (entries: readonly string[]) => void;
}) {
  const { top, bottom } = useSafeAreaInsets();
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const allSelected = entries.length > 0 && selected.size === entries.length;

  useEffect(() => {
    if (!visible) setSelected(new Set());
  }, [visible]);

  useEffect(() => {
    setSelected(current => new Set([...current].filter(entry => entries.includes(entry))));
  }, [entries]);

  const toggleEntry = (entry: string) => {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(entry)) next.delete(entry);
      else next.add(entry);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(entries));
  };

  const copyEntry = (entry: string) => {
    Clipboard.setString(entry);
    if (Platform.OS === 'android') ToastAndroid.show(t('settings.historyEntryCopied'), ToastAndroid.SHORT);
    else Alert.alert(t('settings.historyEntryCopied'));
  };

  const confirmDelete = () => {
    if (selected.size === 0) return;
    const selectedEntries = [...selected];
    Alert.alert(
      t('settings.deleteHistoryTitle'),
      t('settings.deleteHistoryCopy', { count: selectedEntries.length }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            onDelete(selectedEntries);
            setSelected(new Set());
          },
        },
      ],
    );
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
      visible={visible}>
      <View
        className="flex-1 bg-background"
        style={{ paddingTop: Math.max(12, top), paddingBottom: Math.max(12, bottom) }}>
        <View className="flex-row items-center border-b border-border px-4 pb-3">
          <View className="min-w-0 flex-1 pr-3">
            <Text className="text-[20px] font-semibold leading-6">{t('settings.manageTerminalHistory')}</Text>
            <Text className="mt-1 text-[12px] leading-4 text-muted-foreground">{t('settings.manageTerminalHistoryDescription')}</Text>
          </View>
          <IconButton icon={X} accessibilityLabel={t('common.close')} onPress={onClose} />
        </View>

        <View className="min-h-12 flex-row items-center border-b border-border px-4 py-2">
          <Text className="min-w-0 flex-1 text-[12px] font-semibold text-muted-foreground">
            {t('settings.selectedHistoryCount', { count: selected.size })}
          </Text>
          <Button
            className="h-9 rounded-full px-3"
            disabled={entries.length === 0}
            variant="ghost"
            onPress={toggleAll}>
            <Text className="text-[12px] font-semibold text-primary">
              {t(allSelected ? 'settings.clearSelection' : 'settings.selectAll')}
            </Text>
          </Button>
        </View>

        {entries.length === 0 ? (
          <View className="flex-1 items-center justify-center px-8">
            <Icon as={History} className="text-muted-foreground" size={28} />
            <Text className="mt-3 text-center text-[14px] text-muted-foreground">{t('settings.terminalHistoryEmpty')}</Text>
          </View>
        ) : (
          <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
            {entries.map((entry, index) => {
              const isSelected = selected.has(entry);
              return (
                <Button
                  key={entry}
                  accessibilityHint={t('settings.copyHistoryEntryHint')}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isSelected }}
                  className={cn('min-h-14 justify-start rounded-none px-4 py-3', index > 0 && 'border-t border-border')}
                  size="content"
                  variant="ghost"
                  onPress={() => toggleEntry(entry)}
                  onLongPress={hapticPress(() => copyEntry(entry))}>
                  <View className={cn('size-5 items-center justify-center rounded border border-muted-foreground', isSelected && 'border-primary bg-primary')}>
                    {isSelected ? <Icon as={Check} className="text-primary-foreground" size={14} /> : null}
                  </View>
                  <Text
                    numberOfLines={4}
                    className="min-w-0 flex-1 font-mono text-[14px] leading-5 text-foreground"
                    style={{ fontFamily: terminalFontFamily }}>
                    {entry}
                  </Text>
                </Button>
              );
            })}
          </ScrollView>
        )}

        <View className="border-t border-border px-4 pt-3">
          <Button
            className="rounded-full"
            disabled={selected.size === 0}
            variant="destructive"
            onPress={hapticPress(confirmDelete)}>
            <Trash2 size={17} color="#FFFFFF" />
            <Text>{t('settings.deleteSelected')}</Text>
          </Button>
        </View>
      </View>
    </Modal>
  );
}

function TerminalBackgroundRow({ busy, uri, dimming, onChoose, onRemove }: { busy: boolean; uri: string | null; dimming: number; onChoose: () => Promise<void>; onRemove: () => Promise<void> }) {
  const { t } = useTranslation();
  return (
    <View className="border-t border-border p-3.5">
      <View className="mb-3"><DetailsTitle title={t('settings.backgroundImage')} copy={t('settings.backgroundImageCopy')} /></View>
      <View className="relative h-28 overflow-hidden rounded-md bg-terminal-canvas">
        {uri ? <Image source={{ uri }} resizeMode="cover" fadeDuration={180} className="absolute inset-0 size-full" /> : null}
        {uri ? <View className="absolute inset-0" style={{ backgroundColor: `rgba(24, 24, 24, ${dimming / 100})` }} /> : null}
        <View className="absolute inset-0 justify-end p-3"><Text style={styles.terminalPreviewText} className="text-xs text-terminal-text">user@host:~ $ herdr status</Text><Text style={styles.terminalPreviewText} className="mt-1 text-[10px] text-terminal-muted">{t('settings.terminalPreview')}</Text></View>
      </View>
      <View className="mt-3 flex-row gap-2">
        <Button className="flex-1 rounded-full" variant="secondary" disabled={busy} onPress={hapticPress(onChoose)}><Icon as={ImagePlus} size={16} /><Text>{uri ? t('settings.replaceImage') : t('settings.chooseImage')}</Text></Button>
        {uri ? <Button className="rounded-full px-4" variant="ghost" disabled={busy} onPress={hapticPress(onRemove)}><Icon as={Trash2} className="text-destructive" size={16} /><Text className="text-destructive">{t('common.remove')}</Text></Button> : null}
      </View>
    </View>
  );
}

function AppBackgroundRow({ busy, uri, dimming, onChoose, onRemove }: { busy: boolean; uri: string | null; dimming: number; onChoose: () => Promise<void>; onRemove: () => Promise<void> }) {
  const { t } = useTranslation();
  return (
    <View className="p-3.5">
      <View className="mb-3"><DetailsTitle title={t('settings.backgroundImage')} copy={t('settings.backgroundImageCopy')} /></View>
      <View className="relative h-28 overflow-hidden rounded-md bg-background">
        {uri ? <Image source={{ uri }} resizeMode="cover" fadeDuration={180} className="absolute inset-0 size-full" /> : null}
        {uri ? <View className="absolute inset-0 bg-background" style={{ opacity: dimming / 100 }} /> : null}
        <View className="absolute inset-0 justify-between p-3">
          <Text className="text-base font-semibold">Herdr</Text>
          <Text className="text-xs text-muted-foreground">{t('settings.appPreview')}</Text>
        </View>
      </View>
      <View className="mt-3 flex-row gap-2">
        <Button className="flex-1 rounded-full" variant="secondary" disabled={busy} onPress={hapticPress(onChoose)}><Icon as={ImagePlus} size={16} /><Text>{uri ? t('settings.replaceImage') : t('settings.chooseImage')}</Text></Button>
        {uri ? <Button className="rounded-full px-4" variant="ghost" disabled={busy} onPress={hapticPress(onRemove)}><Icon as={Trash2} className="text-destructive" size={16} /><Text className="text-destructive">{t('common.remove')}</Text></Button> : null}
      </View>
    </View>
  );
}

function DetailsTitle({ title, copy, titleClassName = 'text-[15px] font-semibold leading-5' }: { title: string; copy: string; titleClassName?: string }) {
  const { showDetails } = useContext(SettingsDetailsContext);
  const buttonRef = useRef<View>(null);
  const { t } = useTranslation();
  return (
    <View className="min-w-0">
      <View className="flex-row items-center">
        <Text className={`min-w-0 flex-shrink ${titleClassName}`}>{title}</Text>
        <Pressable
          ref={buttonRef}
          accessibilityHint={copy}
          accessibilityLabel={t('settings.details', { name: title })}
          accessibilityRole="button"
          className="ml-1 size-8 items-center justify-center rounded-full active:bg-muted"
          hitSlop={8}
          onPress={event => {
            event.stopPropagation();
            buttonRef.current?.measureInWindow((_x, y) => {
              showDetails(copy, y);
            });
          }}>
          <Icon as={Info} className="text-muted-foreground" size={16} />
        </Pressable>
      </View>
    </View>
  );
}

function SettingRow({ title, copy, value, onChange, divided = false, disabled = false }: { title: string; copy: string; value: boolean; onChange: (value: boolean) => void; divided?: boolean; disabled?: boolean }) {
  return <View className={divided ? 'min-h-16 flex-row items-center border-t border-border px-3.5 py-2' : 'min-h-16 flex-row items-center px-3.5 py-2'}><View className="flex-1 pr-[18px]"><DetailsTitle title={title} copy={copy} /></View><Switch checked={value} disabled={disabled} onCheckedChange={onChange} /></View>;
}

function ActionRow({ title, copy, icon, value, onPress, divided = false }: { title: string; copy: string; icon: LucideIcon; value?: string; onPress: () => void | Promise<void>; divided?: boolean }) {
  return (
    <Button className={divided ? 'min-h-16 justify-start rounded-none border-t border-border px-3.5 py-2' : 'min-h-16 justify-start rounded-none px-3.5 py-2'} size="content" variant="ghost" onPress={hapticPress(onPress)}>
      <View className="size-10 items-center justify-center rounded-full bg-primary/10"><Icon as={icon} className="text-primary" size={18} /></View>
      <View className="ml-3 min-w-0 flex-1"><DetailsTitle title={title} copy={copy} /></View>
      {value ? <Text className="max-w-[90px] text-right text-xs font-semibold text-primary">{value}</Text> : null}
      <Icon as={ChevronRight} className="text-muted-foreground" size={18} />
    </Button>
  );
}

const styles = StyleSheet.create({
  terminalPreviewText: { fontFamily: 'monospace' },
  detailsTooltip: {
    elevation: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.24,
    shadowRadius: 12,
  },
});
