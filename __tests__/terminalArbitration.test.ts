import {
  TerminalArbitration,
  type TerminalDimensions,
} from '../src/lib/terminalArbitration';

const phoneSize: TerminalDimensions = {
  columns: 80,
  rows: 24,
  cellWidthPx: 9,
  cellHeightPx: 18,
};

function displace(arbitration: TerminalArbitration): boolean {
  return arbitration.recordDisplacement();
}

describe('terminal client arbitration', () => {
  test('repeated bridge displacement without new input yields', () => {
    const arbitration = new TerminalArbitration();

    expect(displace(arbitration)).toBe(false);
    expect(displace(arbitration)).toBe(true);
    expect(arbitration.state).toMatchObject({
      consecutiveDisplacements: 2,
      yielded: true,
    });
  });

  test('a yielded client stops scheduling automatic reconnects', () => {
    const arbitration = new TerminalArbitration();
    let reconnects = 0;
    const bridgeClosed = () => {
      if (!displace(arbitration)) reconnects += 1;
    };

    bridgeClosed();
    bridgeClosed();
    if (!arbitration.state.yielded) reconnects += 1;

    expect(reconnects).toBe(1);
  });

  test('resize while yielded is cached but is not remotely writable', () => {
    const arbitration = new TerminalArbitration();
    displace(arbitration);
    displace(arbitration);

    arbitration.cacheDimensions(phoneSize);

    expect(arbitration.latestDimensions()).toEqual(phoneSize);
    expect(arbitration.shouldSendResize()).toBe(false);
  });

  test('new local input clears yield and resets the displacement episode', () => {
    const arbitration = new TerminalArbitration();
    displace(arbitration);
    displace(arbitration);

    const activity = arbitration.recordUserInput();

    expect(activity).toEqual({ generation: 1, reclaimRequired: true });
    expect(arbitration.state).toEqual({
      inputGeneration: 1,
      reconnectGeneration: 1,
      consecutiveDisplacements: 0,
      yielded: false,
    });
  });

  test('first input after yielding waits for takeover and cached resize', async () => {
    const arbitration = new TerminalArbitration();
    displace(arbitration);
    displace(arbitration);
    arbitration.cacheDimensions(phoneSize);
    const order: string[] = [];
    let finishTakeover!: () => void;
    const takeover = new Promise<void>(resolve => {
      finishTakeover = resolve;
    });

    const pending = arbitration.queueUserInput({
      prepare: async (activity, dimensions) => {
        order.push(`takeover:${activity.reclaimRequired}`);
        await takeover;
        order.push(`resize:${dimensions?.columns}x${dimensions?.rows}`);
      },
      send: () => {
        order.push('input:a');
      },
    });
    await Promise.resolve();
    expect(order).toEqual(['takeover:true']);

    finishTakeover();
    await pending;

    expect(order).toEqual(['takeover:true', 'resize:80x24', 'input:a']);
  });

  test('new input resets displacement counting to its new generation', () => {
    const arbitration = new TerminalArbitration();
    displace(arbitration);
    arbitration.recordUserInput();

    expect(displace(arbitration)).toBe(false);
    expect(arbitration.state).toMatchObject({
      inputGeneration: 1,
      reconnectGeneration: 1,
      consecutiveDisplacements: 1,
      yielded: false,
    });
  });

  test('a successful reconnect does not erase displacement churn', () => {
    const arbitration = new TerminalArbitration();

    expect(displace(arbitration)).toBe(false);
    // A bridge opening successfully is intentionally not an arbitration event.
    expect(displace(arbitration)).toBe(true);
  });

  test('pending active-user input keeps retrying through transport churn', async () => {
    const arbitration = new TerminalArbitration();
    let finishRecovery!: () => void;
    const recovery = new Promise<void>(resolve => {
      finishRecovery = resolve;
    });
    const sent = jest.fn();
    const pending = arbitration.queueUserInput({
      prepare: () => recovery,
      send: sent,
    });

    expect(displace(arbitration)).toBe(false);
    expect(displace(arbitration)).toBe(false);
    expect(arbitration.state.yielded).toBe(false);

    finishRecovery();
    await pending;
    expect(sent).toHaveBeenCalledTimes(1);
  });

  test('a genuine transport failure does not count as displacement', async () => {
    const arbitration = new TerminalArbitration();
    await expect(arbitration.queueUserInput({
      prepare: () => Promise.reject(new Error('network unavailable')),
      send: jest.fn(),
    })).rejects.toThrow('network unavailable');

    expect(arbitration.state).toMatchObject({
      consecutiveDisplacements: 0,
      yielded: false,
    });

    const sent = jest.fn();
    await arbitration.queueUserInput({
      prepare: () => Promise.resolve(),
      send: sent,
    });
    expect(sent).toHaveBeenCalledTimes(1);
    expect(arbitration.state.inputGeneration).toBe(2);
  });

  test('retrying the same queued submission does not invent new user activity', async () => {
    const arbitration = new TerminalArbitration();
    await arbitration.queueUserInput({
      prepare: () => Promise.resolve(),
      send: () => Promise.resolve(),
    });

    await arbitration.queueUserInput({
      newUserInput: false,
      prepare: () => Promise.resolve(),
      send: () => Promise.resolve(),
    });

    expect(arbitration.state.inputGeneration).toBe(1);
  });

  test('two idle clients stop taking over from each other', () => {
    const clients = [new TerminalArbitration(), new TerminalArbitration()];
    const reconnectQueue: number[] = [];
    let owner: number | null = null;
    let takeovers = 0;
    const connect = (client: number) => {
      if (owner !== null && owner !== client && !clients[owner].recordDisplacement()) {
        reconnectQueue.push(owner);
      }
      owner = client;
      takeovers += 1;
    };

    connect(0);
    connect(1);
    while (reconnectQueue.length > 0 && takeovers < 20) {
      connect(reconnectQueue.shift()!);
    }

    expect(takeovers).toBeLessThan(20);
    expect(reconnectQueue).toHaveLength(0);
    expect(clients.some(client => client.state.yielded)).toBe(true);
  });
});
