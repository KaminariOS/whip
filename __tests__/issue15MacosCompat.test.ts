import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Regression guard for https://github.com/KaminariOS/whip/issues/15
// Two macOS-host bugs verified against a live Herdr 0.7.4:
//  - `nc -N -U` aborts on Apple netcat (bare `-N` needs an int arg there).
//  - bare `herdr` isn't found over a non-login SSH shell (Homebrew PATH).
const client = readFileSync(
  resolve(__dirname, '../src/services/HerdrClient.ts'),
  'utf8',
);

describe('issue #15: macOS host compatibility', () => {
  test('session snapshot uses portable `nc -U` (no bare `-N`)', () => {
    // Whitespace-tolerant so reformatting can't silently disarm the guard.
    expect(client).toMatch(/\|\s*nc\s+-U\s/);
    // The core regression: never reintroduce Apple-hostile `nc -N`.
    expect(client).not.toMatch(/\bnc\s+-N\b/);
  });

  test('command shell seeds Homebrew + /usr/local PATH so bare `herdr` resolves', () => {
    expect(client).toContain('/opt/homebrew/bin');
    expect(client).toContain('/opt/homebrew/sbin');
    expect(client).toContain('/usr/local/bin');
    // Assert intent, not the exact launch string: the inherited PATH is
    // preserved and `/bin/sh` is the launched shell — so a refactor that keeps
    // both (e.g. wrapping in `/bin/sh -c ...`) doesn't spuriously fail.
    expect(client).toMatch(/:\$PATH"/);
    expect(client).toMatch(/\/bin\/sh/);
  });
});
