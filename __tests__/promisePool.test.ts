import { allSettledWithConcurrency } from '../src/lib/promisePool';

test('bounds concurrency and retains input result order', async () => {
  let active = 0;
  let maximumActive = 0;
  const releases: Array<() => void> = [];
  const operation = jest.fn(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise<void>(resolve => releases.push(resolve));
    active -= 1;
  });

  const result = allSettledWithConcurrency(['one', 'two', 'three'], 2, operation);
  await Promise.resolve();
  expect(operation).toHaveBeenCalledTimes(2);
  expect(maximumActive).toBe(2);

  releases.shift()?.();
  await Promise.resolve();
  await Promise.resolve();
  expect(operation).toHaveBeenCalledTimes(3);

  releases.splice(0).forEach(release => release());
  await expect(result).resolves.toEqual([
    { status: 'fulfilled', value: undefined },
    { status: 'fulfilled', value: undefined },
    { status: 'fulfilled', value: undefined },
  ]);
});

test('settles failures without preventing later work', async () => {
  const result = await allSettledWithConcurrency(['bad', 'good'], 1, async item => {
    if (item === 'bad') throw new Error('failed');
  });

  expect(result[0]).toMatchObject({ status: 'rejected', reason: new Error('failed') });
  expect(result[1]).toEqual({ status: 'fulfilled', value: undefined });
});
