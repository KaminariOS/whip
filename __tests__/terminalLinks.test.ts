import {
  isSshTunnelHost,
  localTunnelUrl,
  terminalWebLinkTarget,
} from '../src/lib/terminalLinks';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('terminal web links', () => {
  it.each([
    'localhost',
    'api.localhost',
    '0.0.0.0',
    '127.0.0.1',
    '127.12.4.8',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.50.2',
    '169.254.10.2',
    '::1',
    'fd12:3456::1',
    'fe80::10',
  ])('routes %s through SSH', hostname => {
    expect(isSshTunnelHost(hostname)).toBe(true);
  });

  it.each(['example.com', '8.8.8.8', '172.32.0.1', '192.169.0.1'])('opens %s directly', hostname => {
    expect(isSshTunnelHost(hostname)).toBe(false);
  });

  it('derives the remote endpoint and preserves the path when tunneling', () => {
    expect(terminalWebLinkTarget('http://localhost:5173/docs?q=one#intro')).toEqual({
      url: 'http://localhost:5173/docs?q=one#intro',
      hostname: 'localhost',
      port: 5173,
      requiresSshTunnel: true,
    });
    expect(localTunnelUrl('http://localhost:5173/docs?q=one#intro', 43127)).toBe(
      'http://localhost:43127/docs?q=one#intro',
    );
    expect(localTunnelUrl('http://192.168.1.4:8080/', 43128)).toBe('http://127.0.0.1:43128/');
  });

  it('uses the protocol default port', () => {
    expect(terminalWebLinkTarget('https://example.com/path').port).toBe(443);
    expect(terminalWebLinkTarget('http://example.com/path').port).toBe(80);
  });

  it('routes every link through the persisted in-app toggle', () => {
    const session = readFileSync(
      resolve(__dirname, '../src/components/SessionScreen.tsx'),
      'utf8',
    );

    expect(session).toContain('checked={terminalPreferences.openLinksInApp}');
    expect(session).toContain('if (!terminalPreferences.openLinksInApp)');
    expect(session).toContain('await Linking.openURL(target.url)');
    expect(session.indexOf('await Linking.openURL(target.url)')).toBeLessThan(
      session.indexOf('const tunnel = await client.openWebTunnel(target.url)'),
    );
  });
});
