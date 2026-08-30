import Constants from 'expo-constants';

import { isUnknownRecord } from '../lib/unknown';

export type DistributionChannel = 'app-store' | 'google-play' | 'github';

const DISTRIBUTION_CHANNELS: ReadonlySet<string> = new Set([
  'app-store',
  'google-play',
  'github',
]);

export interface BillingDistribution {
  channel: DistributionChannel | null;
  rancherWebPurchaseUrl: string | null;
}

function optionalHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function billingDistributionFromExtra(
  extra: unknown,
): BillingDistribution {
  if (!isUnknownRecord(extra)) {
    return { channel: null, rancherWebPurchaseUrl: null };
  }
  const rawChannel = extra.distributionChannel;
  const channel =
    typeof rawChannel === 'string' && DISTRIBUTION_CHANNELS.has(rawChannel)
      ? (rawChannel as DistributionChannel)
      : null;
  return {
    channel,
    rancherWebPurchaseUrl: optionalHttpsUrl(extra.rancherWebPurchaseUrl),
  };
}

export function getBillingDistribution(): BillingDistribution {
  return billingDistributionFromExtra(Constants.expoConfig?.extra);
}

export function isNativeStoreChannel(
  channel: DistributionChannel | null,
): channel is 'app-store' | 'google-play' {
  return channel === 'app-store' || channel === 'google-play';
}
