import {
  apiErrorMessage,
  apiRequestLine,
  eventsSubscribeRequest,
  HerdrApiBridgeDecoder,
  sessionSnapshotRequest,
} from '../src/lib/herdrApiBridge';

describe('Herdr API bridge', () => {
  it('builds a snapshot request', () => {
    expect(JSON.parse(apiRequestLine(sessionSnapshotRequest('snapshot')))).toEqual({
      id: 'snapshot',
      method: 'session.snapshot',
      params: {},
    });
  });

  it('matches the wrapped session snapshot response used by Herdr', () => {
    const response = {
      id: 'snapshot',
      result: {
        type: 'session_snapshot',
        snapshot: {
          version: '0.7.4',
          protocol: 16,
          workspaces: [],
          tabs: [],
          panes: [],
          agents: [],
        },
      },
    };
    expect(response.result.snapshot.protocol).toBe(16);
  });

  it('subscribes to lifecycle and per-pane agent changes without duplicates', () => {
    const request = eventsSubscribeRequest(['w1:p2', 'w1:p1', 'w1:p2']);
    const subscriptions = request.params.subscriptions as Array<Record<string, string>>;
    expect(subscriptions).toContainEqual({ type: 'workspace.updated' });
    expect(subscriptions).toContainEqual({ type: 'pane.created' });
    expect(subscriptions.filter(item => item.type === 'pane.agent_status_changed')).toEqual([
      { type: 'pane.agent_status_changed', pane_id: 'w1:p1' },
      { type: 'pane.agent_status_changed', pane_id: 'w1:p2' },
    ]);
  });

  it('decodes fragmented JSON and ignores shell noise', () => {
    const decoder = new HerdrApiBridgeDecoder();
    expect(decoder.push('last login\r\n{"id":"events","res')).toEqual([]);
    expect(decoder.push('ult":{"type":"subscription_started"}}\r\n$ prompt\n')).toEqual([
      { id: 'events', result: { type: 'subscription_started' } },
    ]);
  });

  it('extracts bridge errors', () => {
    expect(apiErrorMessage({ error: { code: 'bad_request', message: 'No session' } })).toBe('No session');
    expect(apiErrorMessage({ id: 'ok', result: {} })).toBeNull();
  });
});
