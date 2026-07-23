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
    expect(appUi).toContain('lineHeight: glyphBoxSize');
    expect(appUi).toContain('includeFontPadding: false');
    expect(appUi).toContain("textAlignVertical: 'center'");
    expect(appUi).toContain("Platform.OS === 'android' && styles.statusGlyphTextAndroid");
    expect(appUi).toContain('transform: [{ translateY: -1 }]');
    expect(appUi).not.toContain('textShadowColor');
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
    expect(appUi).toContain('outputRange: [0.42, 0.82]');
  });

  it('keeps native animated props mounted when a connection spinner becomes idle', () => {
    const appUi = readFileSync(
      resolve(__dirname, '../src/components/app-ui.tsx'),
      'utf8',
    );

    expect(appUi).toContain(': { opacity: 1, transform: [{ scale: 1 }] };');
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

    expect(app).toContain(
      'agentStatus: aggregateAgentStatus(session.snapshot.workspaces.map(workspace => workspace.agent_status))',
    );
    expect(rail).toContain(
      '<AnimatedAgentStatusGlyph status={session.agentStatus} color={sessionStatusColor(session, colors)} size={12} />',
    );
  });

  it('uses one status glyph per Herd attention row', () => {
    const herd = readFileSync(resolve(__dirname, '../src/components/HerdScreen.tsx'), 'utf8');

    expect(herd).toContain('<AnimatedAgentStatusGlyph status={agent.agent_status} color={tone} />');
    expect(herd).toContain('<StatusBadge showIndicator={false} status={agent.agent_status} label={stateLabel} />');
  });
});
