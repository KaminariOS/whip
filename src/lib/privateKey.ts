export function normalizePrivateKey(value: string): string {
  return value.replace(/\\n/g, '\n').trim();
}
