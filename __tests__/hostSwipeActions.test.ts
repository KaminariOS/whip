import {
  HOST_SWIPE_ACTION_WIDTH,
  hostSwipeOffset,
} from '../src/lib/hostSwipeActions';

describe('host swipe actions', () => {
  it('binds the shared policy to the full host action width', () => {
    expect(hostSwipeOffset(-300, false)).toBe(-HOST_SWIPE_ACTION_WIDTH);
  });
});
