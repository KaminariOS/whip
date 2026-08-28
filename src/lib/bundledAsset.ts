export function bundledAsset(value: unknown): number {
  if (typeof value !== 'number') {
    throw new TypeError('Metro did not resolve the bundled asset to a numeric resource ID');
  }
  return value;
}
