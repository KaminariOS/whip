import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readSource = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('terminal composer keyboard overlay', () => {
  it('uses normal resize behavior by default and changes only composer input to overlay mode', () => {
    const manifest = readSource('android/app/src/main/AndroidManifest.xml');
    const module = readSource(
      'android/app/src/main/java/io/github/kaminarios/whip/HerdrSoftInputModule.kt',
    );
    const screen = readSource('src/components/TerminalScreen.tsx');

    expect(manifest).toContain('android:windowSoftInputMode="adjustResize"');
    expect(module).toContain('SOFT_INPUT_ADJUST_NOTHING');
    expect(module).toContain('SOFT_INPUT_ADJUST_RESIZE');
    expect(module).toContain('overlayOwners.add(owner)');
    expect(module).toContain('overlayOwners.remove(owner)');
    expect(screen).toContain('setTerminalComposerOverlay(terminalId, true)');
    expect(screen).toContain('setTerminalComposerOverlay(terminalId, false)');
    expect(screen).toContain(
      'setTerminalComposerOverlay(terminalId, visible && composeOpen)',
    );
  });

  it('hides the keyboard before closing the composer and restoring resize mode', () => {
    const screen = readSource('src/components/TerminalScreen.tsx');
    const closeCompose = screen.slice(
      screen.indexOf('const closeCompose = async () => {'),
      screen.indexOf('const openCompose = () => {'),
    );

    expect(screen).toContain("Keyboard.addListener('keyboardDidHide'");
    expect(closeCompose.indexOf('await closeComposerKeyboard()')).toBeLessThan(
      closeCompose.indexOf('setComposeOpen(false)'),
    );
    expect(closeCompose.indexOf('setComposeOpen(false)')).toBeLessThan(
      closeCompose.indexOf('setTerminalComposerOverlay(terminalId, false)'),
    );
  });

  it('registers the native soft-input bridge', () => {
    const nativePackage = readSource(
      'android/app/src/main/java/io/github/kaminarios/whip/HerdrBackgroundPackage.kt',
    );

    expect(nativePackage).toContain('HerdrSoftInputModule(reactContext)');
  });
});
