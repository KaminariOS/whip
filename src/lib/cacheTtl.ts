export type CacheTier = 'ok' | 'warn' | 'crit';

export function cacheTierFromTokens(
  tokens?: Record<string, string>,
): { tier: CacheTier | null; label: string | null } {
  if (!tokens) return { tier: null, label: null };
  if (tokens.cache_crit) return { tier: 'crit', label: tokens.cache_crit };
  if (tokens.cache_warn) return { tier: 'warn', label: tokens.cache_warn };
  if (tokens.cache_ok) return { tier: 'ok', label: tokens.cache_ok };
  return { tier: null, label: null };
}

export function shouldNotifyCacheTransition(
  previous: CacheTier | null,
  next: CacheTier | null,
): boolean {
  if (!next || next === 'ok') return false;
  const severity = { ok: 0, warn: 1, crit: 2 };
  const prevSev = previous ? severity[previous] : -1;
  return severity[next] > prevSev;
}

export function updateCacheTier(
  tierMap: Map<string, CacheTier>,
  paneId: string,
  tokens?: Record<string, string>,
): { tier: CacheTier | null; shouldNotify: boolean } {
  const { tier } = cacheTierFromTokens(tokens);
  const previous = tierMap.get(paneId) ?? null;
  if (tier) {
    tierMap.set(paneId, tier);
  } else {
    tierMap.delete(paneId);
  }
  return { tier, shouldNotify: shouldNotifyCacheTransition(previous, tier) };
}

export function cacheTierColor(
  tier: CacheTier,
  colors: { success: string; warning: string; destructive: string },
): string {
  if (tier === 'ok') return colors.success;
  if (tier === 'warn') return colors.warning;
  return colors.destructive;
}
