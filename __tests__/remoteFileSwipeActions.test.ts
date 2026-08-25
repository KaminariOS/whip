import {
  REMOTE_FILE_SWIPE_ACTION_WIDTH,
  remoteFileSwipeOffset,
} from '../src/lib/remoteFileSwipeActions';

describe('remote file swipe actions', () => {
  it('binds the shared policy to the delete action width', () => {
    expect(remoteFileSwipeOffset(-300, false)).toBe(
      -REMOTE_FILE_SWIPE_ACTION_WIDTH,
    );
  });
});
