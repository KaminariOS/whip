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
    expect(app).toContain('onExit={() => exitTerminalToHerd(session.id)}');
  });

  it('only starts an agent inside the selected space', () => {
    const app = readSource('App.tsx');
    const herd = readSource('src/components/HerdScreen.tsx');

    expect(herd).toContain('if (!selectedQueue || !selectedWorkspace || !name.trim() || !command.trim()) return;');
    expect(herd).toContain('await onStart(selectedQueue.id, selectedWorkspace.workspace_id, name, command);');
    expect(herd).toContain('{selectedWorkspace ? (');
    expect(app).toContain('await runtime.client.startAgent(workspaceId, name, command);');
  });
});
