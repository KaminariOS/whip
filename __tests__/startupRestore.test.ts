import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('startup host restoration', () => {
  const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');

  it('renders the application after local state loads without waiting for SSH', () => {
    expect(app).toContain('if (!profilesLoaded || !preferencesLoaded || !liveHostsLoaded)');
    expect(app).not.toContain(
      'if (!profilesLoaded || !preferencesLoaded || !liveHostsLoaded || !liveHostRestoreComplete)',
    );
  });

  it('restores saved hosts concurrently without stealing the active selection', () => {
    expect(app).toContain('await Promise.allSettled(persisted.hostIds.map(async hostId => {');
    expect(app).toContain('trackConnecting: false');
    expect(app).toContain('activateSession: hostId === persisted.activeHostId');
  });

  it('reopens only a terminal that survived startup restoration', () => {
    expect(app).toContain('if (restoredTerminals.activeTerminalId) restoredTerminalHostIdsRef.current.add(nextProfile.id)');
    expect(app).toContain('if (reopenTerminalOnLaunch)');
    expect(app).toContain("setNavigation(current => selectMobileTab(current, 'terminal'))");
    expect(app).toContain("preferences.lastTab === 'terminal' ? 'hosts' : preferences.lastTab");
  });

  it('keeps the display awake only while the terminal screen is visible', () => {
    expect(app).toContain("useKeepAwake('herdr-terminal')");
    expect(app).toContain('activeTerminalVisible = immersiveTerminal && Boolean(activeSession?.terminals.activeTerminalId)');
    expect(app).toContain('keepScreenOn && activeTerminalVisible ? <TerminalKeepAwake /> : null');
  });
});
