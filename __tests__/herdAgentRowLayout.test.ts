import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('herd agent row layout', () => {
  const screen = readFileSync(
    resolve(__dirname, '../src/components/HerdScreen.tsx'),
    'utf8',
  );

  it('virtualizes agent rows as padded glass surfaces', () => {
    expect(screen).toContain('<FlatList');
    expect(screen).toContain('windowSize={7}');
    expect(screen).toContain('removeClippedSubviews');
    expect(screen).toContain('ItemSeparatorComponent={AgentRowSeparator}');
    expect(screen).toContain('const AgentRow = memo(');
    expect(screen).toContain('rounded-xl border border-white/30');
    expect(screen).toContain(
      'min-h-[90px] w-full justify-start gap-3 rounded-none px-3',
    );
  });

  it('only reveals the destructive treatment while swiping', () => {
    expect(screen).toContain('width: Math.max(0, -translateX.value)');
    expect(screen).toContain('style={actionRevealStyle}');
    expect(screen).toContain('overflow-hidden rounded-r-xl bg-destructive');
  });
});
