import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { en } from '../src/locales/en';

describe('terminal server-unavailable state', () => {
  const screen = readFileSync(
    resolve(__dirname, '../src/components/SessionScreen.tsx'),
    'utf8',
  );

  it('does not present a stopped or missing Herdr server as an empty session', () => {
    expect(screen).toContain('{!activeTarget && !snapshot.server.running && (');
    expect(screen).toContain("t('session.serverUnavailable')");
    expect(screen).toContain(
      '{!activeTarget && snapshot.server.running && !selectedTab && (',
    );
  });

  it('directs the user to the recovery actions on the Herd screen', () => {
    expect(en['session.serverUnavailable']).toBe('HERDR UNAVAILABLE');
    expect(en['session.serverUnavailableCopy']).toContain('open an SSH shell');
    expect(screen).toContain("<Text>{t('session.backToHerd')}</Text>");
  });
});
