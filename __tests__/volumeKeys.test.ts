import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  parseTerminalVolumeKeyAction,
  resolveTerminalVolumeKeyAction,
} from '../src/lib/volumeKeys';

describe('terminal volume keys', () => {
  test('maps paired actions according to the physical key direction', () => {
    expect(resolveTerminalVolumeKeyAction('font-size', 'up')).toEqual({ type: 'font-size', delta: 1 });
    expect(resolveTerminalVolumeKeyAction('font-size', 'down')).toEqual({ type: 'font-size', delta: -1 });
    expect(resolveTerminalVolumeKeyAction('scroll', 'up')).toEqual({ type: 'scroll', direction: 'up' });
    expect(resolveTerminalVolumeKeyAction('terminal-tab', 'up')).toEqual({ type: 'terminal-tab', direction: -1 });
    expect(resolveTerminalVolumeKeyAction('terminal-tab', 'down')).toEqual({ type: 'terminal-tab', direction: 1 });
    expect(resolveTerminalVolumeKeyAction('vertical-arrow', 'up')).toEqual({ type: 'input', data: '\u001b[A' });
    expect(resolveTerminalVolumeKeyAction('horizontal-arrow', 'up')).toEqual({ type: 'input', data: '\u001b[D' });
    expect(resolveTerminalVolumeKeyAction('horizontal-arrow', 'down')).toEqual({ type: 'input', data: '\u001b[C' });
    expect(resolveTerminalVolumeKeyAction('none', 'up')).toBeNull();
  });

  test('accepts only supported persisted actions', () => {
    expect(parseTerminalVolumeKeyAction('terminal-tab')).toBe('terminal-tab');
    expect(parseTerminalVolumeKeyAction('brightness')).toBe('none');
  });

  test('preserves normal Android volume handling until an active terminal opts in', () => {
    const activity = readFileSync(resolve(__dirname, '../android/app/src/main/java/io/github/kaminarios/whip/MainActivity.kt'), 'utf8');
    const module = readFileSync(resolve(__dirname, '../android/app/src/main/java/io/github/kaminarios/whip/HerdrVolumeKeysModule.kt'), 'utf8');
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');

    expect(activity).toContain('if (!HerdrVolumeKeysModule.shouldIntercept(keyCode)) return super.onKeyDown');
    expect(module).toContain('@Volatile private var isEnabled = false');
    expect(app).toContain('enabled={activeTerminalVisible}');
    expect(app).toContain("return () => configureTerminalVolumeKeys(false, 'none', 'none')");
  });
});
