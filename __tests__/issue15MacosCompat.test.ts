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
    expect(client).toContain('| nc -U ');
    expect(client).not.toContain('nc -N');
  });

  test('command shell seeds Homebrew + /usr/local PATH so bare `herdr` resolves', () => {
    expect(client).toContain('/opt/homebrew/bin');
    expect(client).toContain('/opt/homebrew/sbin');
    expect(client).toContain('/usr/local/bin');
    // still ends in /bin/sh and preserves the inherited PATH
    expect(client).toContain(':$PATH" /bin/sh');
  });
});
