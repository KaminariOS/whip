import {
  hostCredentialService,
  hostDisplayName,
  migrateLegacyProfile,
  parseHosts,
  sortHosts,
  toHostProfile,
} from '../src/lib/hostProfiles';
import type { ConnectionProfile, HostProfile } from '../src/types';

const profile: ConnectionProfile = {
  id: 'host-1',
  name: 'Savior',
  host: 'savior.example.ts.net',
  port: '22',
  username: 'kosumi',
  authMode: 'key',
  secret: 'private',
  passphrase: '',
  herdrCommand: 'herdr',
  sessionName: '',
  rememberCredentials: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

test('strips credentials from persisted host metadata', () => {
  const host = toHostProfile(profile);
  expect(host).not.toHaveProperty('secret');
  expect(host).not.toHaveProperty('passphrase');
  expect(host.name).toBe('Savior');
});

test('migrates the legacy single profile into a stable first host', () => {
  const migrated = migrateLegacyProfile(JSON.stringify({
    host: 'savior.tailnet.ts.net',
    port: '2222',
    username: 'kosumi',
    authMode: 'key',
    herdrCommand: 'herdr',
    rememberCredentials: true,
  }));
  expect(migrated).toMatchObject({
    id: 'host-legacy-default',
    name: 'savior',
    host: 'savior.tailnet.ts.net',
    port: '2222',
  });
});

test('sorts most recently connected hosts first', () => {
  const hosts: HostProfile[] = [
    { ...toHostProfile(profile), id: 'old', name: 'Old', lastConnectedAt: '2026-01-01T00:00:00.000Z' },
    { ...toHostProfile(profile), id: 'new', name: 'New', lastConnectedAt: '2026-06-01T00:00:00.000Z' },
  ];
  expect(sortHosts(hosts).map(host => host.id)).toEqual(['new', 'old']);
});

test('uses isolated credential services per host', () => {
  expect(hostCredentialService('host-1')).toBe('dev.herdr.remote.ssh.host.host-1');
  expect(hostDisplayName({ name: '', username: 'root', host: 'box' })).toBe('root@box');
  expect(parseHosts('not json')).toEqual([]);
});
