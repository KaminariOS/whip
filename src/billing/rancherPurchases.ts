import Purchases, {
  type CustomerInfo,
  type CustomerInfoUpdateListener,
  type PurchasesOffering,
  type PurchasesPackage,
} from 'react-native-purchases';
import RevenueCatUI, { PAYWALL_RESULT } from 'react-native-purchases-ui';

import {
  initializeRevenueCat,
  isPurchaseCancellation,
  recordRevenueCatFailure,
} from '../services/revenueCat';
import { RANCHER_ENTITLEMENT_IDENTIFIER } from './revenueCatEntitlements';

export const RANCHER_OFFERING_IDENTIFIER = 'default';
export const RANCHER_LIFETIME_PACKAGE_IDENTIFIER = '$rc_lifetime';

export interface RancherOfferingState {
  offering: PurchasesOffering;
  rancherPackage: PurchasesPackage;
}

export type RancherPurchaseResult =
  | { status: 'purchased'; customerInfo: CustomerInfo }
  | { status: 'cancelled' };

export async function loadRevenueCatCustomerInfo(): Promise<CustomerInfo | null> {
  if (!(await initializeRevenueCat())) return null;
  try {
    return await Purchases.getCustomerInfo();
  } catch (error) {
    recordRevenueCatFailure('warn', 'revenuecat-customer-info-read-failed', error);
    throw error;
  }
}

export async function loadRancherOffering(): Promise<RancherOfferingState | null> {
  if (!(await initializeRevenueCat())) return null;
  try {
    const offerings = await Purchases.getOfferings();
    const offering = offerings.current;
    const rancherPackage = offering?.lifetime ?? null;
    if (
      offering?.identifier !== RANCHER_OFFERING_IDENTIFIER ||
      rancherPackage?.identifier !== RANCHER_LIFETIME_PACKAGE_IDENTIFIER
    ) return null;
    return {
      offering,
      rancherPackage,
    };
  } catch (error) {
    recordRevenueCatFailure('warn', 'revenuecat-rancher-offering-load-failed', error);
    return null;
  }
}

export async function purchaseRancherPackage(
  rancherPackage: PurchasesPackage,
): Promise<RancherPurchaseResult> {
  try {
    const result = await Purchases.purchasePackage(rancherPackage);
    return { status: 'purchased', customerInfo: result.customerInfo };
  } catch (error) {
    if (isPurchaseCancellation(error)) return { status: 'cancelled' };
    recordRevenueCatFailure('error', 'revenuecat-rancher-purchase-failed', error);
    throw error;
  }
}

export async function restoreRevenueCatPurchases(): Promise<CustomerInfo> {
  try {
    return await Purchases.restorePurchases();
  } catch (error) {
    recordRevenueCatFailure('error', 'revenuecat-restore-failed', error);
    throw error;
  }
}

export async function presentRancherPaywall(
  offering: PurchasesOffering,
): Promise<PAYWALL_RESULT> {
  try {
    const result = await RevenueCatUI.presentPaywallIfNeeded({
      requiredEntitlementIdentifier: RANCHER_ENTITLEMENT_IDENTIFIER,
      offering,
      displayCloseButton: true,
    });
    if (result === PAYWALL_RESULT.ERROR) {
      throw new Error('RevenueCat could not complete the paywall operation.');
    }
    return result;
  } catch (error) {
    recordRevenueCatFailure('error', 'revenuecat-paywall-presentation-failed', error);
    throw error;
  }
}

export async function addRevenueCatCustomerInfoListener(
  listener: CustomerInfoUpdateListener,
): Promise<(() => void) | null> {
  if (!(await initializeRevenueCat())) return null;
  Purchases.addCustomerInfoUpdateListener(listener);
  return () => {
    Purchases.removeCustomerInfoUpdateListener(listener);
  };
}

export function paywallResultRequiresRefresh(
  result: PAYWALL_RESULT,
): boolean {
  return (
    result === PAYWALL_RESULT.PURCHASED ||
    result === PAYWALL_RESULT.RESTORED ||
    result === PAYWALL_RESULT.NOT_PRESENTED
  );
}
