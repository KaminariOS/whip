import {
  isWhipPairingCode,
  normalizeEd25519PublicKey,
  profileFromPairing,
} from '../src/lib/sshPairing';

describe('SSH QR pairing helpers', () => {
  it('accepts a bare Ed25519 public key and normalizes spacing', () => {
    expect(normalizeEd25519PublicKey('  ssh-ed25519   AAAAC3NzaC1lZDI1NTE5AAAAIA==  phone  '))
      .toBe('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA== phone');
  });

  it('rejects private keys, authorized_keys options, and non-Ed25519 keys', () => {
    expect(normalizeEd25519PublicKey('-----BEGIN OPENSSH PRIVATE KEY-----')).toBeNull();
    expect(normalizeEd25519PublicKey('from="10.0.0.1" ssh-ed25519 AAAA')).toBeNull();
    expect(normalizeEd25519PublicKey('ssh-rsa AAAA')).toBeNull();
  });

  it('recognizes only the current compact pairing envelope', () => {
    expect(isWhipPairingCode(' WP3:BB8 ')).toBe(true);
    expect(isWhipPairingCode('WP2:BB8')).toBe(false);
    expect(isWhipPairingCode('https://example.com')).toBe(false);
  });

  it('creates a usable saved profile when the selected key has private material', () => {
    const profile = profileFromPairing({
      sshHost: 'server.example.test',
      sshPort: 2222,
      sshUser: 'alice',
      sshHostFingerprint: 'SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      alreadyPresent: false,
    }, {
      source: 'generated',
      label: 'New key',
      publicKey: 'ssh-ed25519 AAAA',
      privateKey: 'PRIVATE',
      passphrase: '',
    });

    expect(profile).toMatchObject({
      name: 'server',
      host: 'server.example.test',
      port: '2222',
      username: 'alice',
      authMode: 'key',
      secret: 'PRIVATE',
    });
  });
});
