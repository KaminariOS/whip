import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getInstallationTimeAsync } from 'expo-application';
import { AppState, Linking } from 'react-native';
import type {
  CustomerInfo,
  PurchasesOffering,
  PurchasesPackage,
} from 'react-native-purchases';

import { reportBackgroundFailure } from '../services/backgroundOperations';
import { hasCapability as tierHasCapability, type WhipCapability } from './capabilities';
import {
  getBillingDistribution,
  isNativeStoreChannel,
  type DistributionChannel,
} from './distribution';
import {
  addRevenueCatCustomerInfoListener,
  loadRancherOffering,
  loadRevenueCatCustomerInfo,
  paywallResultRequiresRefresh,
  presentRancherPaywall,
  purchaseRancherPackage,
  restoreRevenueCatPurchases,
} from './rancherPurchases';
import {
  resolveWhipEntitlements,
  type WhipEntitlementSnapshot,
} from './revenueCatEntitlements';
import {
  INACTIVE_RANCHER_TRIAL,
  resolveRancherTrial,
  type RancherTrialSnapshot,
} from './rancherTrial';
import type { WhipTier } from './tiers';

type EntitlementLoadStatus = 'loading' | 'ready' | 'unavailable';
export type WhipPurchaseActionResult =
  | 'purchased'
  | 'cancelled'
  | 'opened-web-checkout';

export interface WhipEntitlementsController {
  tier: WhipTier;
  hasCapability: (capability: WhipCapability) => boolean;
  isLoading: boolean;
  rancherPackage: PurchasesPackage | null;
  localizedLifetimePrice: string | null;
  distributionChannel: DistributionChannel | null;
  hasLifetimeAccess: boolean;
  isTrialActive: boolean;
  trialDaysRemaining: number;
  trialEndsAt: Date | null;
  purchasesAvailable: boolean;
  canRestore: boolean;
  purchaseRancher: () => Promise<WhipPurchaseActionResult>;
  presentRancherPaywall: () => Promise<WhipPurchaseActionResult>;
  restorePurchases: () => Promise<void>;
  refresh: () => Promise<void>;
}

interface ControllerState {
  customerInfo: CustomerInfo | null;
  offering: PurchasesOffering | null;
  rancherPackage: PurchasesPackage | null;
  status: EntitlementLoadStatus;
  trial: RancherTrialSnapshot;
  trialLoading: boolean;
}

const INITIAL_ENTITLEMENT: WhipEntitlementSnapshot =
  resolveWhipEntitlements(null);

export function useWhipEntitlements(
  billingEnabled: boolean,
): WhipEntitlementsController {
  const distribution = useMemo(() => getBillingDistribution(), []);
  const mounted = useRef(true);
  const [state, setState] = useState<ControllerState>({
    customerInfo: null,
    offering: null,
    rancherPackage: null,
    status: 'loading',
    trial: INACTIVE_RANCHER_TRIAL,
    trialLoading: true,
  });

  const refreshTrial = useCallback(async () => {
    if (!billingEnabled) return;
    let trial = INACTIVE_RANCHER_TRIAL;
    try {
      trial = resolveRancherTrial(await getInstallationTimeAsync());
    } catch {
      // A platform that cannot provide a trustworthy install time is ineligible.
    }
    if (mounted.current) {
      setState(current => ({ ...current, trial, trialLoading: false }));
    }
  }, [billingEnabled]);

  const refresh = useCallback(async () => {
    if (!billingEnabled) return;
    let customerInfo: CustomerInfo | null;
    try {
      customerInfo = await loadRevenueCatCustomerInfo();
    } catch {
      if (mounted.current) {
        setState(current => ({
          ...current,
          status: current.customerInfo ? 'ready' : 'unavailable',
        }));
      }
      return;
    }
    if (!customerInfo) {
      if (mounted.current) {
        setState(current => ({ ...current, status: 'unavailable' }));
      }
      return;
    }
    const offering = await loadRancherOffering();
    if (!mounted.current) return;
    setState(current => ({
      ...current,
      customerInfo,
      offering: offering?.offering ?? current.offering,
      rancherPackage: offering?.rancherPackage ?? current.rancherPackage,
      status: 'ready',
    }));
  }, [billingEnabled]);

  useEffect(() => {
    mounted.current = true;
    if (!billingEnabled) {
      setState({
        customerInfo: null,
        offering: null,
        rancherPackage: null,
        status: 'unavailable',
        trial: INACTIVE_RANCHER_TRIAL,
        trialLoading: false,
      });
      return () => {
        mounted.current = false;
      };
    }
    reportBackgroundFailure(refresh(), 'revenuecat-entitlements-load');
    reportBackgroundFailure(refreshTrial(), 'rancher-trial-load');
    let cancelled = false;
    let removeListener: (() => void) | null = null;
    reportBackgroundFailure(
      addRevenueCatCustomerInfoListener(customerInfo => {
        if (mounted.current) {
          setState(current => ({ ...current, customerInfo, status: 'ready' }));
        }
      }).then(remove => {
        if (cancelled) remove?.();
        else removeListener = remove;
      }),
      'revenuecat-customer-info-listener',
    );
    const appStateSubscription = AppState.addEventListener('change', next => {
      if (next === 'active') {
        reportBackgroundFailure(refresh(), 'revenuecat-entitlements-refresh');
        reportBackgroundFailure(refreshTrial(), 'rancher-trial-refresh');
      }
    });
    return () => {
      cancelled = true;
      mounted.current = false;
      removeListener?.();
      appStateSubscription.remove();
    };
  }, [billingEnabled, refresh, refreshTrial]);

  useEffect(() => {
    const endsAtMs = state.trial.endsAt?.getTime();
    if (!billingEnabled || !state.trial.isActive || !endsAtMs) return;
    const delayMs = Math.max(0, endsAtMs - Date.now());
    const timeout = setTimeout(() => {
      reportBackgroundFailure(refreshTrial(), 'rancher-trial-expiry');
    }, delayMs + 1);
    return () => clearTimeout(timeout);
  }, [billingEnabled, refreshTrial, state.trial.endsAt, state.trial.isActive]);

  const entitlement = state.customerInfo
    ? resolveWhipEntitlements(state.customerInfo)
    : INITIAL_ENTITLEMENT;
  const hasLifetimeAccess = entitlement.tier === 'rancher';
  const tier: WhipTier = hasLifetimeAccess || state.trial.isActive
    ? 'rancher'
    : 'cowboy';
  const configuredWebUrl = distribution.rancherWebPurchaseUrl;
  const revenueCatWebUrl =
    state.rancherPackage?.webCheckoutUrl ?? state.offering?.webCheckoutUrl;
  const webPurchaseUrl = revenueCatWebUrl ?? configuredWebUrl;
  const nativeStore = isNativeStoreChannel(distribution.channel);
  const purchasesAvailable = billingEnabled && (
    nativeStore
      ? state.rancherPackage !== null && state.offering !== null
      : distribution.channel === 'github' && webPurchaseUrl !== null
  );

  const openWebCheckout = useCallback(async () => {
    if (!webPurchaseUrl) throw new Error('Rancher web checkout is unavailable.');
    await Linking.openURL(webPurchaseUrl);
  }, [webPurchaseUrl]);

  const purchaseRancher = useCallback(async (): Promise<WhipPurchaseActionResult> => {
    if (distribution.channel === 'github') {
      await openWebCheckout();
      return 'opened-web-checkout';
    }
    if (!nativeStore || !state.rancherPackage) {
      throw new Error('Rancher purchases are unavailable in this build.');
    }
    const result = await purchaseRancherPackage(state.rancherPackage);
    if (result.status === 'cancelled') return 'cancelled';
    if (mounted.current) {
      setState(current => ({
        ...current,
        customerInfo: result.customerInfo,
        status: 'ready',
      }));
    }
    return 'purchased';
  }, [distribution.channel, nativeStore, openWebCheckout, state.rancherPackage]);

  const openPaywall = useCallback(async (): Promise<WhipPurchaseActionResult> => {
    if (distribution.channel === 'github') {
      await openWebCheckout();
      return 'opened-web-checkout';
    }
    if (!nativeStore || !state.offering) {
      throw new Error('Rancher purchases are unavailable in this build.');
    }
    const result = await presentRancherPaywall(state.offering);
    if (paywallResultRequiresRefresh(result)) {
      await refresh();
      return 'purchased';
    }
    return 'cancelled';
  }, [distribution.channel, nativeStore, openWebCheckout, refresh, state.offering]);

  const restorePurchases = useCallback(async () => {
    if (!nativeStore) {
      throw new Error('Purchase restoration is unavailable in this build.');
    }
    const customerInfo = await restoreRevenueCatPurchases();
    if (mounted.current) {
      setState(current => ({
        ...current,
        customerInfo,
        status: 'ready',
      }));
    }
  }, [nativeStore]);

  return {
    tier,
    hasCapability: capability =>
      tierHasCapability(tier, capability),
    isLoading: state.status === 'loading' || state.trialLoading,
    rancherPackage: state.rancherPackage,
    localizedLifetimePrice: state.rancherPackage?.product.priceString ?? null,
    distributionChannel: distribution.channel,
    hasLifetimeAccess,
    isTrialActive: state.trial.isActive,
    trialDaysRemaining: state.trial.daysRemaining,
    trialEndsAt: state.trial.endsAt,
    purchasesAvailable,
    canRestore: nativeStore,
    purchaseRancher,
    presentRancherPaywall: openPaywall,
    restorePurchases,
    refresh,
  };
}
