import { AGENT_SPINNER_FRAMES, agentStatusGlyph, statusMotionKind, statusTone } from '../src/lib/statusMotion';

test('matches the native Herdr agent status glyphs', () => {
  expect(agentStatusGlyph('blocked')).toBe('◉');
  expect(agentStatusGlyph('done')).toBe('●');
  expect(agentStatusGlyph('idle')).toBe('✓');
  expect(agentStatusGlyph('unknown')).toBe('○');
  expect(AGENT_SPINNER_FRAMES.map((_, frame) => agentStatusGlyph('working', frame))).toEqual(AGENT_SPINNER_FRAMES);
});

test('uses continuous rotation for active work and connection states', () => {
  expect(statusMotionKind('working')).toBe('spin');
  expect(statusMotionKind('running')).toBe('spin');
  expect(statusMotionKind('connecting')).toBe('spin');
  expect(statusMotionKind('reconnecting')).toBe('spin');
});

test('uses a pulse for attention states and no motion for settled states', () => {
  expect(statusMotionKind('blocked')).toBe('pulse');
  expect(statusMotionKind('waiting')).toBe('pulse');
  expect(statusMotionKind('done')).toBe('static');
  expect(statusMotionKind('idle')).toBe('static');
});

test('keeps agent state colors aligned with their semantic tone', () => {
  expect(statusTone('working')).toBe('success');
  expect(statusTone('blocked')).toBe('destructive');
  expect(statusTone('connecting')).toBe('warning');
  expect(statusTone('idle')).toBe('muted');
});
