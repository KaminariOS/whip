import { normalizePrivateKey } from '../src/lib/privateKey';

describe('normalizePrivateKey', () => {
  test('converts escaped newlines from secret inputs', () => {
    expect(normalizePrivateKey('  -----BEGIN KEY-----\\nbody\\n-----END KEY-----  ')).toBe(
      '-----BEGIN KEY-----\nbody\n-----END KEY-----',
    );
  });

  test('preserves multiline keys', () => {
    expect(normalizePrivateKey('head\nbody\n')).toBe('head\nbody');
  });
});
