import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('host list layout', () => {
  it('lets host content determine row height at large font scales', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/HostsScreen.tsx'),
      'utf8',
    );
    const button = readFileSync(
      resolve(__dirname, '../src/components/ui/button.tsx'),
      'utf8',
    );

    expect(button).toContain("content: ''");
    expect(screen).toContain('size="content"');
    expect(screen).toContain('h-auto min-h-[88px] min-w-0 flex-1 self-stretch');
    expect(screen).toContain('sm:h-auto');
  });

  it('places vertical space between host rows', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/HostsScreen.tsx'),
      'utf8',
    );

    expect(screen).toContain('<View className="gap-3">');
    expect(screen).toContain('<GlassSurface className="min-h-[88px]');
  });

  it('shows agent-state counts and the Herdr protocol from existing live snapshots', () => {
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
    const screen = readFileSync(resolve(__dirname, '../src/components/HostsScreen.tsx'), 'utf8');

    expect(app).toContain('hostRuntimeSummary(session.snapshot)');
    expect(app).toContain('runtimeByHostId=');
    expect(screen).toContain("status={runtime?.agentStatus ?? 'unknown'}");
    expect(screen).toContain("? t('hosts.agentStatus', { status: t(`status.${runtime.agentStatus}`) })");
    expect(screen).not.toContain('<AgentStateCount');
    expect(screen).not.toContain('displayName.slice(0, 1).toUpperCase()');
    expect(screen).toContain("t('hosts.herdrProtocolNone')");
    expect(screen).toContain("t('hosts.herdrProtocol', { version: runtime.protocol })");
  });

  it('uses a distinct server-off icon for disconnected hosts', () => {
    const screen = readFileSync(resolve(__dirname, '../src/components/HostsScreen.tsx'), 'utf8');
    const appUi = readFileSync(resolve(__dirname, '../src/components/app-ui.tsx'), 'utf8');

    expect(screen).toContain('icon={runtime ? undefined : ServerOff}');
    expect(screen).toContain(": t('status.disconnected')");
    expect(appUi).toContain('icon?: LucideIcon;');
  });

  it('does not show a stale last-connected age while a host is open', () => {
    const screen = readFileSync(resolve(__dirname, '../src/components/HostsScreen.tsx'), 'utf8');

    expect(screen).toContain('!connected && host.lastConnectedAt');
    expect(screen).toContain("t('hosts.lastConnected', { value: formatLastUsed(host.lastConnectedAt, t) })");
  });

  it('presents connection failures as a readable live-region message', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/HostsScreen.tsx'),
      'utf8',
    );

    expect(screen).toContain('accessibilityLiveRegion="polite"');
    expect(screen).toContain("t('hosts.errorTitle')");
  });

  it('clips swipe actions to the amount revealed by the row', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/HostsScreen.tsx'),
      'utf8',
    );

    expect(screen).toContain('width: Math.max(0, -translateX.value)');
    expect(screen).toContain('style={actionRevealStyle}');
    expect(screen).toContain('className="absolute inset-y-0 right-0 overflow-hidden"');
  });
});
