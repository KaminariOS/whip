import {
  apiEvent,
  apiErrorMessage,
  eventsSubscribeRequest,
  HerdrApiBridgeDecoder,
} from '../src/lib/herdrApiBridge';

describe('Herdr API bridge', () => {
  it('subscribes to lifecycle and per-pane agent changes without duplicates', () => {
    const request = eventsSubscribeRequest(20, ['w1:p2', 'w1:p1', 'w1:p2']);
    const subscriptions = request.params.subscriptions as Array<Record<string, string>>;
    expect(subscriptions).toContainEqual({ type: 'workspace.updated' });
    expect(subscriptions).toContainEqual({ type: 'workspace.metadata_updated' });
    expect(subscriptions).toContainEqual({ type: 'workspace.reordered' });
    expect(subscriptions).toContainEqual({ type: 'pane.created' });
    expect(subscriptions).toContainEqual({ type: 'pane.updated' });
    expect(subscriptions).toContainEqual({ type: 'layout.updated' });
    expect(subscriptions.filter(item => item.type === 'pane.agent_status_changed')).toEqual([
      { type: 'pane.agent_status_changed', pane_id: 'w1:p1' },
      { type: 'pane.agent_status_changed', pane_id: 'w1:p2' },
    ]);
    expect(eventsSubscribeRequest(17, []).params.subscriptions).not.toContainEqual({
      type: 'workspace.reordered',
    });
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
    expect(apiErrorMessage({ id: 'ok', result: { type: 'ok' } })).toBeNull();
  });

  it('decodes direct and legacy-wrapped focus events', () => {
    expect(apiEvent({
      event: 'tab.focused',
      data: { workspace_id: 'w1', tab_id: 't2' },
    })).toEqual({
      event: 'tab.focused',
      data: { workspace_id: 'w1', tab_id: 't2' },
    });
    expect(apiEvent({
      subscription_id: 'focus',
      event: { event: 'pane.focused', data: { workspace_id: 'w1', pane_id: 'p2' } },
    })).toEqual({
      event: 'pane.focused',
      data: { workspace_id: 'w1', pane_id: 'p2' },
    });
  });

  it('fully decodes nested domain objects at the bridge boundary', () => {
    const pane = {
      pane_id: 'p1',
      terminal_id: 'terminal-1',
      workspace_id: 'w1',
      tab_id: 't1',
      focused: true,
      agent_status: 'working',
      revision: 7,
    };
    expect(apiEvent({ event: 'pane.updated', data: { pane } })).toEqual({
      event: 'pane.updated',
      data: { pane },
    });
    expect(apiEvent({
      event: 'pane.updated',
      data: { pane: { pane_id: 'p1' } },
    })).toEqual({
      event: 'protocol.invalid',
      data: {
        raw_event: 'pane.updated',
        reason: 'pane.terminal_id must be a string',
      },
    });
    expect(apiEvent({
      event: 'pane.updated',
      data: {
        pane: {
          ...pane,
          agent_session: {
            source: 'codex',
            agent: 'codex',
            kind: 'future',
            value: 'session-1',
          },
        },
      },
    })).toEqual({
      event: 'protocol.invalid',
      data: {
        raw_event: 'pane.updated',
        reason: 'pane.agent_session.kind must be id or path',
      },
    });
  });

  it('distinguishes unknown events from malformed known events', () => {
    expect(apiEvent({
      event: 'workspace.reordered',
      data: { workspace_ids: [], workspaces: [] },
    })).toEqual({
      event: 'workspace.reordered',
      data: { workspace_ids: [], workspaces: [] },
    });
    expect(apiEvent({
      event: 'pane.output_changed',
      data: { workspace_id: 'w1', pane_id: 'p1', revision: 8 },
    })).toEqual({
      event: 'pane.output_changed',
      data: { workspace_id: 'w1', pane_id: 'p1', revision: 8 },
    });
    expect(apiEvent({ event: 'future.created', data: {} })).toEqual({
      event: 'protocol.unknown',
      data: { raw_event: 'future.created' },
    });
    expect(apiEvent({ event: 'tab.focused', data: null })).toEqual({
      event: 'protocol.invalid',
      data: { raw_event: 'tab.focused', reason: 'event data must be an object' },
    });
  });
});
