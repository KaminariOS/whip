import {
  createEventRefreshScheduler,
  eventInvalidatesTopology,
} from '../src/lib/eventRefreshScheduler';

describe('event refresh scheduling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('recognizes topology-invalidating lifecycle events', () => {
    expect(eventInvalidatesTopology('workspace.created')).toBe(true);
    expect(eventInvalidatesTopology('tab.closed')).toBe(true);
    expect(eventInvalidatesTopology('pane.agent_detected')).toBe(true);
    expect(eventInvalidatesTopology('pane.updated')).toBe(false);
    expect(eventInvalidatesTopology('pane.agent_status_changed')).toBe(false);
  });

  test('refreshes one isolated topology change immediately', () => {
    const refresh = jest.fn();
    const scheduler = createEventRefreshScheduler(refresh, 500);

    scheduler.schedule('tab.created');

    expect(refresh).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(500);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('debounces locally applied events into one trailing reconciliation', () => {
    const refresh = jest.fn();
    const scheduler = createEventRefreshScheduler(refresh, 500);

    scheduler.schedule('pane.agent_status_changed');
    jest.advanceTimersByTime(400);
    scheduler.schedule('pane.updated');
    jest.advanceTimersByTime(400);

    expect(refresh).not.toHaveBeenCalled();
    jest.advanceTimersByTime(100);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('adds one trailing reconciliation when events follow a topology refresh', () => {
    const refresh = jest.fn();
    const scheduler = createEventRefreshScheduler(refresh, 500);

    scheduler.schedule('pane.created');
    scheduler.schedule('layout.updated');
    scheduler.schedule('pane.agent_status_changed');

    expect(refresh).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(500);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  test('cancels a pending reconciliation', () => {
    const refresh = jest.fn();
    const scheduler = createEventRefreshScheduler(refresh, 500);

    scheduler.schedule('layout.updated');
    scheduler.cancel();
    jest.runAllTimers();

    expect(refresh).not.toHaveBeenCalled();
  });
});
