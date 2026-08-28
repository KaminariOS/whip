import Constants from 'expo-constants';

import {
  operationalParseErrorDetails,
  recordOperationalDiagnostic,
} from './operationalDiagnostics';

import type { TipProductId } from './revenueCat';
import { isUnknownRecord } from '../lib/unknown';

export interface SubmittedFeedbackRequest {
  id: string;
  status: string;
  createdAt: string;
}

const REQUEST_TIMEOUT_MS = 15_000;

function apiBaseUrl(): string | null {
  const extra: unknown = Constants.expoConfig?.extra;
  const value = isUnknownRecord(extra) ? extra.feedbackApiUrl : undefined;
  return typeof value === 'string' && value.trim()
    ? value.trim().replace(/\/+$/, '')
    : null;
}

export function isFeedbackApiConfigured(): boolean {
  return apiBaseUrl() !== null;
}

export async function submitFeedbackRequest(input: {
  title: string;
  body: string;
  revenueCatUserId: string | null;
}): Promise<SubmittedFeedbackRequest> {
  return requestJson<SubmittedFeedbackRequest>('/api/requests', {
    method: 'POST',
    body: JSON.stringify({
      type: 'feature',
      title: input.title,
      body: input.body,
      revenuecatUserId: input.revenueCatUserId,
    }),
  });
}

export async function createTipIntent(input: {
  requestId: string;
  revenueCatUserId: string;
  productId: TipProductId;
}): Promise<{ id: string; expiresAt: string }> {
  return requestJson(
    `/api/requests/${encodeURIComponent(input.requestId)}/tip-intent`,
    {
      method: 'POST',
      body: JSON.stringify({
        revenuecatUserId: input.revenueCatUserId,
        productId: input.productId,
      }),
    },
  );
}

async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
  const baseUrl = apiBaseUrl();
  if (!baseUrl)
    throw new Error('Feedback service is not configured for this build.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    const payload = (await response.json().catch(error => {
      recordOperationalDiagnostic('warn', 'Application', 'feedback-response-parse-failed', {
        operation: 'response.json',
        status: response.status,
        ...operationalParseErrorDetails(error),
      });
      if (response.ok) throw new Error('Feedback service returned malformed JSON');
      return null;
    })) as {
      error?: string;
    } | null;
    if (!response.ok) {
      throw new Error(payload?.error || `Request failed (${response.status}).`);
    }
    return payload as T;
  } finally {
    clearTimeout(timeout);
  }
}
