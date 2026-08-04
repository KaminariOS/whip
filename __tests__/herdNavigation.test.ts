import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readSource = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('terminal to Herd navigation', () => {
  it('keeps the Herd space filter outside its conditionally mounted screen', () => {
    const app = readSource('App.tsx');
    const herd = readSource('src/components/HerdScreen.tsx');

    expect(app).toContain('const [herdWorkspaceFilterIds, setHerdWorkspaceFilterIds]');
    expect(app).toContain('workspaceFilterId={selectedHerdWorkspaceId}');
    expect(app).toContain('onWorkspaceFilterChange={setHerdWorkspaceFilter}');
    expect(herd).not.toContain('setWorkspaceFilterId');
  });

  it('returns to the host and space containing the active terminal', () => {
    const app = readSource('App.tsx');

    expect(app).toContain('const exitTerminalToHerd = useCallback((sessionId: string) => {');
    expect(app).toContain('pane.terminal_id === activeTerminalId');
    expect(app).toContain('setHerdHostFilterId(sessionId)');
    expect(app).toContain('setHerdWorkspaceFilter(sessionId, workspaceId)');
    expect(app).toContain('onExit={() => exitTerminalToHerd(activeSession.id)}');
  });

  it('opens the selected space and offers the configured agent command when it is empty', () => {
    const app = readSource('App.tsx');
    const herd = readSource('src/components/HerdScreen.tsx');
    const settings = readSource('src/components/SettingsScreen.tsx');

    expect(herd).toContain('if (!selectedQueue || !selectedWorkspace) return;');
    expect(herd).toContain('await runWorkspaceAction(() => onOpenSpace(');
    expect(herd).toContain('{selectedQueue?.running && selectedWorkspace && queueAgents.length === 0 ? (');
    expect(herd).toContain("t('herd.openSpace')");
    expect(herd).toContain("accessibilityLabel={t('herd.openSpace')}");
    expect(herd).not.toContain('variant="ghost" disabled={workspaceBusy} onPress={hapticPress(openSpace)}');
    expect(herd).not.toContain('selectedQueue ? selectedQueue.address');
    expect(herd.indexOf("accessibilityLabel={t('herd.openSpace')}"))
      .toBeLessThan(herd.indexOf('<Metric value={queueAgents.length}'));
    expect(herd).toContain("accessibilityLabel={t('herd.startAgent')}");
    expect(herd).toContain('onStartAgent(');
    expect(herd).toContain('agentCommand.trim()');
    expect(app).toContain('const openHerdWorkspace = async (sessionId: string, workspaceId: string) => {');
    expect(app).toContain('await selectHerdWorkspace(sessionId, workspaceId);');
    expect(app).toContain("selectLiveHost(sessionId, 'terminal');");
    expect(app).toContain('onOpenSpace={openHerdWorkspace}');
    expect(app).toContain("await runtime.client.startAgent(workspaceId, 'agent', command);");
    expect(app).toContain('agentCommand={agentCommand}');
    expect(settings).toContain("t('settings.agentCommand')");
    expect(settings).toContain('onChangeText={props.onAgentCommandChange}');
  });
});
