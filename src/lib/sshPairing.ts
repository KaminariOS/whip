import type { ConnectionProfile } from '../types';
import { emptyConnectionProfile, legacyHostName } from './hostProfiles';

export type PairingKeySource = 'generated' | 'global' | 'clipboard';

export interface PairingKeySelection {
  source: PairingKeySource;
  label: string;
  publicKey: string;
  privateKey?: string;
  passphrase?: string;
  fingerprint?: string;
}

export interface PairHostResult {
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshHostFingerprint: string;
  keyFingerprint?: string;
  alreadyPresent: boolean;
}

export function normalizeOpenSshPublicKey(value: string): string | null {
  const trimmed = value.trim();
  const hasControlCharacter = [...trimmed].some(character => {
    const codePoint = character.codePointAt(0) || 0;
    return codePoint < 32 || codePoint === 127;
  });
  if (!trimmed || trimmed.length > 4096 || hasControlCharacter) return null;
  const fields = trimmed.split(/\s+/);
  if (fields.length < 2 || !/^[A-Za-z0-9][A-Za-z0-9@._+-]*$/.test(fields[0]))
    return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(fields[1])) return null;
  return fields.join(' ');
}

export function isWhipPairingCode(value: string): boolean {
  return value.trim().startsWith('WP3:');
}

export function profileFromPairing(
  result: PairHostResult,
  key: PairingKeySelection,
): ConnectionProfile {
  return {
    ...emptyConnectionProfile(),
    name: legacyHostName(result.sshHost),
    host: result.sshHost,
    port: String(result.sshPort),
    username: result.sshUser,
    authMode: 'key',
    secret: key.privateKey || '',
    passphrase: key.passphrase || '',
  };
}
