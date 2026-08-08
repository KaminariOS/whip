import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('terminal hierarchy status glyphs', () => {
  it('shows agent status glyphs for spaces and tabs', () => {
    const workspaceRail = readFileSync(
      resolve(__dirname, '../src/components/WorkspaceRail.tsx'),
      'utf8',
    );
    const screen = readFileSync(
      resolve(__dirname, '../src/components/SessionScreen.tsx'),
      'utf8',
    );
    const appUi = readFileSync(
      resolve(__dirname, '../src/components/app-ui.tsx'),
      'utf8',
    );

    expect(workspaceRail).toContain(
      '<AnimatedAgentStatusGlyph status={status} color={statusColor(status, colors)} size={12} />',
    );
    expect(screen).toContain(
      '<AnimatedAgentStatusGlyph status={item.agent_status} color={sessionTabStatusColor(item.agent_status, itemSession?.status, colors)} size={12} />',
    );
    expect(appUi).toContain('const glyphBoxSize = size + 4;');
    expect(appUi).toContain('const AGENT_SPINNER_INTERVAL_MS = 125;');
    expect(appUi).toContain('const agentSpinnerListeners = new Set<() => void>();');
    expect(appUi).toContain('const AgentStatusAnimationContext = createContext(true);');
    expect(appUi).toContain('const animationsEnabled = useContext(AgentStatusAnimationContext);');
    expect(appUi).toContain('const frame = useAgentSpinnerFrame(animationsEnabled && spins && !reduceMotion);');
    expect(appUi).toContain('const { style } = useStatusMotion(status, false);');
    expect(appUi).toContain('export function AgentStatusMedallion');
    expect(appUi).toContain('agentStatusCircleBloomStyle(color, bloomSize)');
    expect(appUi).toContain("filter: [{ blur: 5 }]");
    expect(appUi).toContain('<CircularAgentSpinner frame={frame} color={color} size={size} />');
    expect(appUi).toContain('const AGENT_SPINNER_ORBIT_RADIUS = 9.5;');
    expect(appUi).toContain('const AGENT_SPINNER_TRAIL_OPACITIES = [1, 0.72, 0.5, 0.32, 0.16] as const;');
    expect(appUi).toContain('const angle = (dotIndex / frameCount) * Math.PI * 2 - Math.PI / 2;');
    expect(appUi).toContain('<Circle');
    expect(appUi).toContain('{agentStatusGlyph(status, frame)}');
    expect(appUi).toContain('lineHeight: glyphBoxSize');
    expect(appUi).toContain('includeFontPadding: false');
    expect(appUi).toContain("textAlignVertical: 'center'");
    expect(appUi).toContain("Platform.OS === 'android' && styles.statusGlyphTextAndroid");
    expect(appUi).toContain('transform: [{ translateY: -1 }]');
    expect(appUi).not.toContain('textShadowColor');
  });

  it('pauses hidden Herd status spinners without pausing agent monitoring', () => {
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
    const appUi = readFileSync(
      resolve(__dirname, '../src/components/app-ui.tsx'),
      'utf8',
    );

    expect(app).toContain("<AgentStatusAnimationProvider enabled={navigation.tab === 'herd'}>");
    expect(appUi).toContain("const [appActive, setAppActive] = useState(AppState.currentState === 'active');");
    expect(appUi).toContain("AppState.addEventListener('change', state => {");
    expect(appUi).toContain('value={enabled && appActive}');
    expect(app).toContain("if (event.event === 'pane.agent_status_changed' && paneId)");
    expect(app).toContain('startBackgroundMonitoring(hostCount)');
  });

  it('only breathes the host medallion bloom while its host is connected', () => {
    const appUi = readFileSync(
      resolve(__dirname, '../src/components/app-ui.tsx'),
      'utf8',
    );
    const hosts = readFileSync(
      resolve(__dirname, '../src/components/HostsScreen.tsx'),
      'utf8',
    );

    expect(hosts).toContain('connected={connected}');
    expect(appUi).toContain('const bloomStyle = useConnectedHostBloom(connected, reduceMotion);');
    expect(appUi).toContain('{connected ? (');
    expect(appUi).toContain('withTiming(1, { duration: 1400');
    expect(appUi).toContain('withTiming(0, { duration: 1400');
  });

  it('renders one crisp host glyph inside the outer connected bloom', () => {
    const appUi = readFileSync(
      resolve(__dirname, '../src/components/app-ui.tsx'),
      'utf8',
    );
    const medallion = appUi.slice(
      appUi.indexOf('export function AgentStatusMedallion'),
      appUi.indexOf('function CircularAgentSpinner'),
    );

    expect(medallion.match(/\{glyph\(\)\}/g)).toHaveLength(1);
    expect(medallion).not.toContain('agentStatusIconBloom');
    expect(medallion).toContain('agentStatusCircleBloomStyle(color, bloomSize)');
  });

  it('keeps bloom inside non-idle circular connection indicators', () => {
    const appUi = readFileSync(
      resolve(__dirname, '../src/components/app-ui.tsx'),
      'utf8',
    );

    expect(appUi).toContain("if (status === 'idle')");
    expect(appUi).toContain('className="items-center justify-center overflow-hidden rounded-full"');
    expect(appUi).toContain('statusBloomStyle(color, size)');
    expect(appUi).toContain("const breathes = ['done', 'connected', 'active'].includes(status);");
    expect(appUi).toContain('opacity: 0.42 + (progress.value * 0.4)');
  });

  it('keeps native animated props mounted when a connection spinner becomes idle', () => {
    const appUi = readFileSync(
      resolve(__dirname, '../src/components/app-ui.tsx'),
      'utf8',
    );

    expect(appUi).toContain('return { opacity: 1, transform: [{ scale: 1 }] };');
    expect(appUi).toContain('return { opacity: 0.62, transform: [{ scale: 1 }] };');
  });

  it('keeps host and space status controls in Herd instead of Terminal', () => {
    const herd = readFileSync(resolve(__dirname, '../src/components/HerdScreen.tsx'), 'utf8');
    const hostRail = readFileSync(resolve(__dirname, '../src/components/LiveSessionRail.tsx'), 'utf8');
    const workspaceRail = readFileSync(resolve(__dirname, '../src/components/WorkspaceRail.tsx'), 'utf8');
    const screen = readFileSync(resolve(__dirname, '../src/components/SessionScreen.tsx'), 'utf8');

    expect(herd).toContain('<LiveSessionRail');
    expect(herd).toContain('<WorkspaceRail');
    expect(hostRail).toContain("label: t('rail.allHosts')");
    expect(hostRail).toContain("accessibilityLabel={t('rail.disconnectHost', { host: session.label })}");
    expect(hostRail).toContain("accessibilityLabel={t('rail.newHostSession')}");
    expect(workspaceRail).toContain("label={t('rail.allSpaces')}");
    expect(workspaceRail).toContain("accessibilityLabel={t('rail.newWorkspace')}");
    expect(workspaceRail).toContain("accessibilityLabel={t('rail.closeWorkspace', { workspace: label })}");
    expect(workspaceRail).toContain('onLongPress={onLongPress ? hapticPress(onLongPress) : undefined}');
    expect(workspaceRail).not.toContain('workspaceActions');
    expect(herd).toContain('autoFocus selectTextOnFocus');
    expect(screen).not.toContain('snapshot.workspaces.map');
    expect(screen).toContain("accessibilityLabel={t('session.backToHerd')}");
  });

  it('shows aggregate agent status glyphs for hosts', () => {
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
    const rail = readFileSync(
      resolve(__dirname, '../src/components/LiveSessionRail.tsx'),
      'utf8',
    );

    expect(app).toMatch(
      /agentStatus:\s*aggregateAgentStatus\(\s*session\.snapshot\.workspaces\.map\(workspace => workspace\.agent_status\),?\s*\)/,
    );
    expect(rail).toContain(
      '<AnimatedAgentStatusGlyph status={session.agentStatus} color={sessionStatusColor(session, colors)} size={12} />',
    );
  });

  it('uses one status glyph per Herd attention row', () => {
    const herd = readFileSync(resolve(__dirname, '../src/components/HerdScreen.tsx'), 'utf8');

    expect(herd).toMatch(/<AnimatedAgentStatusGlyph\s+status={agent\.agent_status}\s+color={tone}\s*\/>/);
    expect(herd).toMatch(/<StatusBadge\s+showIndicator={false}\s+status={agent\.agent_status}\s+label={stateLabel}\s*\/>/);
  });
});
