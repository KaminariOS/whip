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

    expect(workspaceRail).toContain(
      '<AnimatedAgentStatusGlyph status={status} color={statusColor(status)} size={12} />',
    );
    expect(screen).toContain(
      '<AnimatedAgentStatusGlyph status={item.agent_status} color={sessionTabStatusColor(item.agent_status, itemSession?.status)} size={12} />',
    );
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
    expect(workspaceRail).toContain("accessibilityLabel={t('rail.workspaceActions')}");
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
      '<AnimatedAgentStatusGlyph status={session.agentStatus} color={sessionStatusColor(session)} size={12} />',
    );
  });

  it('uses one status glyph per Herd attention row', () => {
    const herd = readFileSync(resolve(__dirname, '../src/components/HerdScreen.tsx'), 'utf8');

    expect(herd).toContain('<AnimatedAgentStatusGlyph status={agent.agent_status} color={tone} />');
    expect(herd).toContain('<StatusBadge showIndicator={false} status={agent.agent_status} label={stateLabel} />');
  });
});
