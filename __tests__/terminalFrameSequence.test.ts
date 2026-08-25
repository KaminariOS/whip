import { TerminalFrameSequence } from '../src/lib/terminalFrameSequence';

const frame = (seq: number, full = false, final = true) => ({ seq, full, final });

describe('TerminalFrameSequence', () => {
  test('accepts a full baseline followed by contiguous frames and chunks', () => {
    const sequence = new TerminalFrameSequence();

    expect(sequence.observe(frame(1, true))).toEqual({
      render: true,
      reset: false,
      requestFull: false,
    });
    expect(sequence.observe(frame(2, false, false)).render).toBe(true);
    expect(sequence.observe(frame(2, false, true)).render).toBe(true);
    expect(sequence.observe(frame(3)).render).toBe(true);
  });

  test('drops a sequence gap and requests one full repaint', () => {
    const sequence = new TerminalFrameSequence();
    sequence.observe(frame(7, true));

    expect(sequence.observe(frame(9))).toEqual({
      render: false,
      reset: false,
      requestFull: true,
    });
    expect(sequence.observe(frame(10))).toEqual({
      render: false,
      reset: false,
      requestFull: false,
    });
    expect(sequence.observe(frame(11, true))).toEqual({
      render: true,
      reset: true,
      requestFull: false,
    });
    expect(sequence.observe(frame(12)).render).toBe(true);
  });

  test('uses an out-of-sequence full frame as a new visible baseline', () => {
    const sequence = new TerminalFrameSequence();
    sequence.observe(frame(1, true));

    expect(sequence.observe(frame(4, true))).toEqual({
      render: true,
      reset: true,
      requestFull: false,
    });
  });

  test('requires a full baseline for a cold stream', () => {
    const sequence = new TerminalFrameSequence();

    expect(sequence.observe(frame(8))).toEqual({
      render: false,
      reset: false,
      requestFull: true,
    });
  });

  test('requests one repaint for invalid sequence metadata', () => {
    const sequence = new TerminalFrameSequence();

    expect(sequence.observe(frame(0))).toEqual({
      render: false,
      reset: false,
      requestFull: true,
    });
    expect(sequence.observe(frame(0)).requestFull).toBe(false);
  });
});
