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
  if (!next) return false;
  const severity = { ok: 0, warn: 1, crit: 2 };
  const prevSev = previous ? severity[previous] : -1;
  return severity[next] > prevSev;
}

export function cacheTierColor(
  tier: CacheTier,
  colors: { success: string; warning: string; destructive: string },
): string {
  if (tier === 'ok') return colors.success;
  if (tier === 'warn') return colors.warning;
  return colors.destructive;
}
