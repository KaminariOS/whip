import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  REMOTE_FILE_SWIPE_ACTION_WIDTH,
  remoteFileSwipeOffset,
  shouldClaimRemoteFileSwipe,
  shouldOpenRemoteFileSwipe,
} from '../src/lib/remoteFileSwipeActions';

describe('remote file swipe actions', () => {
  it('claims deliberate left swipes and right swipes used to close', () => {
    expect(shouldClaimRemoteFileSwipe(-20, 2, false)).toBe(true);
    expect(shouldClaimRemoteFileSwipe(20, 2, false)).toBe(false);
    expect(shouldClaimRemoteFileSwipe(20, 2, true)).toBe(true);
    expect(shouldClaimRemoteFileSwipe(-20, 2, true)).toBe(false);
    expect(shouldClaimRemoteFileSwipe(-20, 19, false)).toBe(false);
    expect(shouldClaimRemoteFileSwipe(-8, 0, false)).toBe(false);
  });

  it('clamps the row to the delete action width', () => {
    expect(remoteFileSwipeOffset(-40, false)).toBe(-40);
    expect(remoteFileSwipeOffset(-300, false)).toBe(-REMOTE_FILE_SWIPE_ACTION_WIDTH);
    expect(remoteFileSwipeOffset(40, false)).toBe(0);
    expect(remoteFileSwipeOffset(40, true)).toBe(-REMOTE_FILE_SWIPE_ACTION_WIDTH + 40);
    expect(remoteFileSwipeOffset(300, true)).toBe(0);
  });

  it('settles using drag distance or velocity', () => {
    expect(shouldOpenRemoteFileSwipe(-REMOTE_FILE_SWIPE_ACTION_WIDTH * 0.6, 0, false)).toBe(true);
    expect(shouldOpenRemoteFileSwipe(-20, -0.5, false)).toBe(true);
    expect(shouldOpenRemoteFileSwipe(20, 0.5, true)).toBe(false);
    expect(shouldOpenRemoteFileSwipe(20, 0, true)).toBe(true);
    expect(shouldOpenRemoteFileSwipe(REMOTE_FILE_SWIPE_ACTION_WIDTH, 0, true)).toBe(false);
  });

  it('reveals delete and requests confirmation before removing the remote entry', () => {
    const manager = readFileSync(
      resolve(__dirname, '../src/components/RemoteFileManager.tsx'),
      'utf8',
    );

    expect(manager).toContain('<SwipeableRemoteFileRow');
    expect(manager).toContain("t('files.deleteTitle', { name })");
    expect(manager).toContain("style: 'destructive'");
    expect(manager).toContain('client.deleteRemoteEntry(entryPath, Boolean(entry.isDirectory))');
  });
});
