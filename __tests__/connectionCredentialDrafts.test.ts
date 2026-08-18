import {
  credentialDraftsForProfile,
  switchCredentialAuthMode,
  updateActiveCredential,
} from '../src/lib/connectionCredentialDrafts';
import type { ConnectionProfile } from '../src/types';

const passwordProfile: ConnectionProfile = {
  id: 'host-1',
  name: 'Mini',
  host: 'mini',
  port: '22',
  username: 'a1',
  authMode: 'password',
  secret: 'mac-password',
  passphrase: '',
  herdrCommand: 'herdr',
  sessionName: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

test('keeps password and generated key drafts separate while switching modes', () => {
  let state = switchCredentialAuthMode(
    passwordProfile,
    credentialDraftsForProfile(passwordProfile),
    'key',
  );
  expect(state.profile.secret).toBe('');

  state = updateActiveCredential(state.profile, state.drafts, 'PRIVATE KEY');
  state = switchCredentialAuthMode(state.profile, state.drafts, 'password');
  expect(state.profile.secret).toBe('mac-password');

  state = updateActiveCredential(state.profile, state.drafts, '');
  state = switchCredentialAuthMode(state.profile, state.drafts, 'key');
  expect(state.profile.secret).toBe('PRIVATE KEY');
});

test('does not expose an existing private key in the password field', () => {
  const keyProfile = {
    ...passwordProfile,
    authMode: 'key' as const,
    secret: 'PRIVATE KEY',
    passphrase: 'key-passphrase',
  };

  const state = switchCredentialAuthMode(
    keyProfile,
    credentialDraftsForProfile(keyProfile),
    'password',
  );

  expect(state.profile.secret).toBe('');
  expect(state.profile.passphrase).toBe('');
  expect(state.drafts.privateKey).toBe('PRIVATE KEY');
  expect(state.drafts.keyPassphrase).toBe('key-passphrase');
});
