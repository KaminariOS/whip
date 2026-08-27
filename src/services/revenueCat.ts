import Constants from 'expo-constants';
import { Platform } from 'react-native';
import Purchases, {
  type PurchasesError,
  type PurchasesStoreProduct,
} from 'react-native-purchases';
import {
  operationalErrorDetails,
  recordOperationalDiagnostic,
} from './operationalDiagnostics';

export const TIP_PRODUCT_IDS = [
  'whip_tip_small',
  'whip_tip_medium',
  'whip_tip_large',
] as const;

export type TipProductId = (typeof TIP_PRODUCT_IDS)[number];

export interface TipProduct {
  id: TipProductId;
  localizedPrice: string;
  storeProduct: PurchasesStoreProduct;
}

let initialization: Promise<boolean> | null = null;

function publicSdkKey(): string | null {
  const extra = Constants.expoConfig?.extra;
  const value = Platform.select({
    ios: extra?.revenueCatIosPublicSdkKey,
    android: extra?.revenueCatAndroidPublicSdkKey,
    default: null,
  });
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function initializeRevenueCat(): Promise<boolean> {
  if (initialization) return initialization;

  initialization = Promise.resolve().then(() => {
    const apiKey = publicSdkKey();
    if (!apiKey || (Platform.OS !== 'ios' && Platform.OS !== 'android'))
      return false;

    try {
      Purchases.configure({
        apiKey,
        automaticDeviceIdentifierCollectionEnabled: false,
      });
      return true;
    } catch (error) {
      recordRevenueCatFailure('error', 'revenuecat-initialization-failed', error);
      return false;
    }
  });
  return initialization;
}

export async function getRevenueCatAppUserId(): Promise<string | null> {
  if (!(await initializeRevenueCat())) return null;
  try {
    return await Purchases.getAppUserID();
  } catch (error) {
    recordRevenueCatFailure('warn', 'revenuecat-app-user-id-read-failed', error);
    return null;
  }
}

export async function loadTipProducts(): Promise<TipProduct[]> {
  if (!(await initializeRevenueCat())) return [];

  let products: PurchasesStoreProduct[];
  try {
    products = await Purchases.getProducts(
      [...TIP_PRODUCT_IDS],
      Purchases.PRODUCT_CATEGORY.NON_SUBSCRIPTION,
    );
  } catch (error) {
    recordRevenueCatFailure('error', 'revenuecat-products-load-failed', error);
    throw error;
  }
  const byId = new Map(products.map(product => [product.identifier, product]));
  return TIP_PRODUCT_IDS.flatMap(id => {
    const storeProduct = byId.get(id);
    return storeProduct
      ? [{ id, localizedPrice: storeProduct.priceString, storeProduct }]
      : [];
  });
}

export async function purchaseTipProduct(
  product: TipProduct,
): Promise<'purchased' | 'cancelled'> {
  try {
    await Purchases.purchaseStoreProduct(product.storeProduct);
    return 'purchased';
  } catch (error) {
    if (isPurchaseCancellation(error)) return 'cancelled';
    recordRevenueCatFailure('error', 'revenuecat-purchase-failed', error);
    throw error;
  }
}

function recordRevenueCatFailure(
  level: 'warn' | 'error',
  event: string,
  error: unknown,
): void {
  recordOperationalDiagnostic(level, 'RevenueCat', event, {
    ...operationalErrorDetails(error),
  });
}

function isPurchaseCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const purchasesError = error as Partial<PurchasesError>;
  return (
    purchasesError.code ===
    Purchases.PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR
  );
}
