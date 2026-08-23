import { OfflineTerminalBackend } from '../src/lib/offlineTerminalBackend';

describe('OfflineTerminalBackend', () => {
  test('owns cached pane content and scroll state per terminal', () => {
    const backend = new OfflineTerminalBackend();

    backend.updateTranscript('one', 'cached output');
    backend.updateScroll('one', {
      offset_from_bottom: 12,
      max_offset_from_bottom: 40,
      viewport_rows: 20,
    });

    expect(backend.snapshot('one')).toEqual({
      transcript: 'cached output',
      scroll: {
        offset_from_bottom: 12,
        max_offset_from_bottom: 40,
        viewport_rows: 20,
      },
    });
    expect(backend.snapshot('two')).toEqual({
      transcript: '',
      scroll: {
        offset_from_bottom: 0,
        max_offset_from_bottom: 0,
        viewport_rows: 0,
      },
    });
  });

  test('preserves scroll for the same capture and resets it for new content', () => {
    const backend = new OfflineTerminalBackend();

    backend.updateTranscript('one', 'first');
    backend.updateScroll('one', {
      offset_from_bottom: 9,
      max_offset_from_bottom: 20,
      viewport_rows: 10,
    });

    expect(backend.updateTranscript('one', 'first').scroll.offset_from_bottom).toBe(9);
    expect(backend.updateTranscript('one', 'second').scroll).toEqual({
      offset_from_bottom: 0,
      max_offset_from_bottom: 0,
      viewport_rows: 0,
    });
  });

  test('normalizes renderer geometry and releases closed terminals', () => {
    const backend = new OfflineTerminalBackend();
    backend.updateTranscript('keep', 'one');
    backend.updateTranscript('remove', 'two');

    expect(backend.updateScroll('keep', {
      offset_from_bottom: 99,
      max_offset_from_bottom: 8.4,
      viewport_rows: 12.6,
    }).scroll).toEqual({
      offset_from_bottom: 8,
      max_offset_from_bottom: 8,
      viewport_rows: 13,
    });

    backend.retain(new Set(['keep']));
    expect(backend.snapshot('keep').transcript).toBe('one');
    expect(backend.snapshot('remove').transcript).toBe('');
  });
});
