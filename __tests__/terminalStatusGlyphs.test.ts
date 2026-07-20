import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('terminal hierarchy status glyphs', () => {
  it('shows agent status glyphs for spaces and tabs', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/SessionScreen.tsx'),
      'utf8',
    );

    expect(screen).toContain(
      '<AnimatedAgentStatusGlyph status={item.agent_status} color={statusColor(item.agent_status)} size={12} />',
    );
    expect(screen).toContain(
      '<AnimatedAgentStatusGlyph status={item.agent_status} color={sessionTabStatusColor(item.agent_status, itemSession?.status)} size={12} />',
    );
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
});
