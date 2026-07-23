import { randomUUID } from 'expo-crypto';

export function createSecureId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
