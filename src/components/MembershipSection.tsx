import { useState } from 'react';
import { Check, Crown, RefreshCcw, Sparkles } from 'lucide-react-native';
import { ActivityIndicator, Alert, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { WhipEntitlementsController } from '../billing/useWhipEntitlements';
import { hapticPress } from './app-ui';
import { GlassSurface } from './GlassSurface';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

type MembershipAction = 'paywall' | 'restore';

const RANCHER_BENEFIT_KEYS = [
  'membership.benefitAppBackground',
  'membership.benefitAppDimming',
  'membership.benefitGlass',
  'membership.benefitTerminalBackground',
  'membership.benefitTerminalDimming',
] as const;

export function MembershipSection({
  entitlements,
}: {
  entitlements: WhipEntitlementsController;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<MembershipAction | null>(null);
  const rancherAccess = entitlements.tier === 'rancher';
  const lifetimeAccess = entitlements.hasLifetimeAccess;

  const run = async (
    action: MembershipAction,
    operation: () => Promise<unknown>,
  ) => {
    setBusy(action);
    try {
      await operation();
    } catch (error) {
      Alert.alert(t('membership.errorTitle'), String(error));
    } finally {
      setBusy(null);
    }
  };

  const status = lifetimeAccess
    ? t('membership.lifetimeAccess')
    : entitlements.isTrialActive
      ? t('membership.trialDaysRemaining', {
        count: entitlements.trialDaysRemaining,
      })
      : t('membership.freeForever');
  const purchaseLabel = t(
    entitlements.isTrialActive
      ? 'membership.keepRancher'
      : 'membership.unlockRancher',
  );

  return (
    <View className="border-t border-border px-4 py-5">
      <Text className="mb-3 px-1 text-sm font-semibold text-muted-foreground">
        {t('membership.title')}
      </Text>
      <GlassSurface className="rounded-lg border border-white/30 p-4 dark:border-white/10">
        <View className="flex-row items-center gap-3">
          <View className="size-11 items-center justify-center rounded-full bg-primary/15">
            <Icon
              as={rancherAccess ? Crown : Sparkles}
              className="text-primary"
              size={22}
            />
          </View>
          <View className="min-w-0 flex-1">
            <Text className="text-[18px] font-semibold">
              {t(rancherAccess ? 'membership.rancher' : 'membership.cowboy')}
            </Text>
            <Text className="mt-0.5 text-xs font-semibold text-primary">
              {entitlements.isLoading ? t('membership.checking') : status}
            </Text>
          </View>
          {entitlements.localizedLifetimePrice && !lifetimeAccess ? (
            <Text className="text-right text-xs font-semibold text-muted-foreground">
              {t('membership.priceOneTime', {
                price: entitlements.localizedLifetimePrice,
              })}
            </Text>
          ) : null}
        </View>

        <Text className="mt-4 text-sm leading-5 text-muted-foreground">
          {lifetimeAccess
            ? t('membership.rancherCopy')
            : entitlements.isTrialActive
              ? t('membership.trialCopy')
              : t('membership.cowboyCopy')}
        </Text>
        {!rancherAccess ? (
          <Text className="mt-1 text-sm leading-5 text-muted-foreground">
            {t('membership.rancherAdds')}
          </Text>
        ) : null}

        <View className="mt-4 gap-2.5">
          <Text className="text-sm font-semibold">
            {t('membership.benefitsTitle')}
          </Text>
          {RANCHER_BENEFIT_KEYS.map(benefitKey => (
            <View className="flex-row items-start gap-2.5" key={benefitKey}>
              <Icon as={Check} className="mt-0.5 text-primary" size={16} />
              <Text className="min-w-0 flex-1 text-sm leading-5 text-muted-foreground">
                {t(benefitKey)}
              </Text>
            </View>
          ))}
        </View>

        {!lifetimeAccess
          && !entitlements.isLoading
          && !entitlements.purchasesAvailable ? (
          <Text className="mt-2 text-xs leading-4 text-muted-foreground">
            {t(
              entitlements.distributionChannel === 'github'
                ? 'membership.webUnavailable'
                : 'membership.purchasesUnavailable',
            )}
          </Text>
        ) : null}

        <View className="mt-4 gap-2">
          {!lifetimeAccess ? (
            <Button
              accessibilityLabel={purchaseLabel}
              accessibilityState={{
                busy: busy === 'paywall',
                disabled:
                  entitlements.isLoading ||
                  !entitlements.purchasesAvailable ||
                  busy !== null,
              }}
              className="rounded-full"
              disabled={
                entitlements.isLoading ||
                !entitlements.purchasesAvailable ||
                busy !== null
              }
              onPress={hapticPress(() => {
                void run('paywall', entitlements.presentRancherPaywall);
              })}>
              {busy === 'paywall' ? <ActivityIndicator color="currentColor" /> : null}
              <Text>{purchaseLabel}</Text>
            </Button>
          ) : null}
          {entitlements.canRestore ? (
            <Button
              accessibilityState={{
                busy: busy === 'restore',
                disabled: busy !== null,
              }}
              className="rounded-full"
              disabled={busy !== null}
              variant="ghost"
              onPress={hapticPress(() => {
                void run('restore', entitlements.restorePurchases);
              })}>
              <Icon as={RefreshCcw} size={16} />
              <Text>{t('membership.restore')}</Text>
            </Button>
          ) : null}
        </View>
      </GlassSurface>
    </View>
  );
}
