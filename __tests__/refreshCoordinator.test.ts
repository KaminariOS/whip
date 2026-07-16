import { createRefreshCoordinator } from '../src/lib/refreshCoordinator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

test('rejects a refresh result invalidated before it resolves', async () => {
  const response = deferred<string>();
  const committed: string[] = [];
  const refresh = createRefreshCoordinator(() => response.promise, value => committed.push(value));

  const result = refresh.request();
  expect(refresh.isRefreshing()).toBe(true);
  refresh.invalidate();
  response.resolve('old host snapshot');

  await expect(result).resolves.toEqual({ status: 'stale' });
  expect(committed).toEqual([]);
  expect(refresh.isRefreshing()).toBe(false);
});

test('serializes refreshes and coalesces concurrent requests into one follow-up', async () => {
  const responses = [deferred<number>(), deferred<number>()];
  const committed: number[] = [];
  let loads = 0;
  let activeLoads = 0;
  let maximumActiveLoads = 0;
  const refresh = createRefreshCoordinator(async () => {
    const response = responses[loads];
    loads += 1;
    activeLoads += 1;
    maximumActiveLoads = Math.max(maximumActiveLoads, activeLoads);
    try {
      return await response.promise;
    } finally {
      activeLoads -= 1;
    }
  }, value => committed.push(value));

  const first = refresh.request();
  const second = refresh.request();
  const third = refresh.request();
  expect(loads).toBe(1);

  responses[0].resolve(1);
  await expect(first).resolves.toEqual({ status: 'applied', value: 1 });
  await Promise.resolve();
  expect(loads).toBe(2);

  responses[1].resolve(2);
  await expect(Promise.all([second, third])).resolves.toEqual([
    { status: 'applied', value: 2 },
    { status: 'applied', value: 2 },
  ]);
  expect(committed).toEqual([1, 2]);
  expect(maximumActiveLoads).toBe(1);
});

test('drops an old queued refresh but permits the new generation to run next', async () => {
  const oldResponse = deferred<string>();
  const newResponse = deferred<string>();
  const committed: string[] = [];
  let loadCount = 0;
  const refresh = createRefreshCoordinator(
    () => (loadCount++ === 0 ? oldResponse.promise : newResponse.promise),
    value => committed.push(value),
  );

  const oldActive = refresh.request();
  const oldQueued = refresh.request();
  refresh.invalidate();
  const current = refresh.request();

  await expect(oldQueued).resolves.toEqual({ status: 'stale' });
  oldResponse.resolve('old');
  await expect(oldActive).resolves.toEqual({ status: 'stale' });
  await Promise.resolve();

  newResponse.resolve('new');
  await expect(current).resolves.toEqual({ status: 'applied', value: 'new' });
  expect(committed).toEqual(['new']);
});

test('reports current-generation failures and remains reusable', async () => {
  const error = new Error('offline');
  const committed: string[] = [];
  let attempts = 0;
  const refresh = createRefreshCoordinator(async () => {
    attempts += 1;
    if (attempts === 1) throw error;
    return 'recovered';
  }, value => committed.push(value));

  await expect(refresh.request()).resolves.toEqual({ status: 'failed', error });
  await expect(refresh.request()).resolves.toEqual({ status: 'applied', value: 'recovered' });
  expect(committed).toEqual(['recovered']);
});
