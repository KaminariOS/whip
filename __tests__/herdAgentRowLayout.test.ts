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
    expect(screen).not.toContain('getItemLayout={getHerdAgentLayout}');
    expect(screen).toContain('const AgentRow = memo(');
    expect(screen).toContain(
      '<Animated.View className="overflow-hidden rounded-xl" style={rowStyle}>',
    );
    expect(screen).toContain('rounded-xl border border-white/30');
    expect(screen).toContain(
      'min-h-[90px] w-full justify-start gap-3 rounded-none px-3',
    );
    expect(screen).not.toContain(
      '<AnimatedEntrance delay={Math.min(index * 45, 225)}>',
    );
  });

  it('keeps queue controls and metrics outside the scrolling agent list', () => {
    const fixedHeader = screen.indexOf('{selectedQueue?.running !== false ? (');
    const scrollingList = screen.indexOf('<FlatList', fixedHeader);
    const header = screen.slice(fixedHeader, scrollingList);

    expect(fixedHeader).toBeGreaterThanOrEqual(0);
    expect(scrollingList).toBeGreaterThan(fixedHeader);
    expect(header).toContain("accessibilityLabel={t('herd.runCommand')}");
    expect(header).not.toContain("accessibilityLabel={t('herd.startAgent')}");
    expect(header).toContain('<Metric value={queueAgents.length}');
    expect(header).toContain("t('herd.attentionQueue')");
  });

  it('lets enlarged Android text determine the resting row height', () => {
    expect(screen).toContain('const HERD_AGENT_ROW_MIN_HEIGHT = 92;');
    expect(screen).toContain(
      'const restingHeightRef = useRef(HERD_AGENT_ROW_MIN_HEIGHT);',
    );
    expect(screen).toContain('const { height, width } = event.nativeEvent.layout;');
    expect(screen).toContain('rowHeight.value = restingHeightRef.current;');
  });

  it('only reveals the destructive treatment while swiping', () => {
    expect(screen).toContain('width: Math.max(0, -translateX.value)');
    expect(screen).toContain('style={actionRevealStyle}');
    expect(screen).toContain('overflow-hidden rounded-r-xl bg-destructive');
  });

  it('omits the redundant space name when a space is selected', () => {
    expect(screen).toContain('showSpace={selectedWorkspaceId === null}');
    expect(screen).toContain(
      'const primaryLabel = showSpace ? item.primaryLabel : item.tabLabel;',
    );
    expect(screen).toContain('previous.showSpace === next.showSpace');
  });
});
