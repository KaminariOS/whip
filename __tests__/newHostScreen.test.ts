import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('New Host screen', () => {
  it('shows both published whip-pair runner commands', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/NewHostScreen.tsx'),
      'utf8',
    );

    expect(screen).toContain("t('pairing.runOnHost')");
    expect(screen).toContain('>uvx whip-pair</Text>');
    expect(screen).toContain('>npx whip-pair</Text>');
    expect(screen.match(/<Text selectable/g)).toHaveLength(2);
  });
});
