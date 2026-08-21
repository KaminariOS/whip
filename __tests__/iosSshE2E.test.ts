import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('iOS SSH integration wiring', () => {
  it('keeps the dedicated runner out of the production entry point', () => {
    const entry = read('index.js');
    const e2eEntry = read('index.ios-e2e.js');
    expect(entry).toContain('registerRootComponent(App)');
    expect(entry).not.toContain('IosSshE2EScreen');
    expect(entry).not.toContain('WhipE2EEnabled');
    expect(e2eEntry).toContain('IosSshE2EScreen');
    expect(e2eEntry).toContain('registerRootComponent(IosSshE2EScreen)');
  });

  it('launches the same app key that Expo registerRootComponent registers', () => {
    const entry = read('index.js');
    const appDelegate = read('ios/HerdR/AppDelegate.swift');
    expect(entry).toContain("import { registerRootComponent } from 'expo'");
    expect(entry).toContain('registerRootComponent(App)');
    expect(appDelegate).toContain('withModuleName: "main"');
    expect(appDelegate).not.toContain('withModuleName: "HerdR"');
  });

  it('covers trust, both authentication modes, shell, SFTP, jump, forwarding, and agent forwarding', () => {
    const runner = read('src/services/iosSshE2E.ts');
    for (const expectation of [
      'E_HOST_KEY_UNKNOWN:',
      'E_HOST_KEY_CHANGED:',
      'connectWithPassword(',
      'connectWithKey(',
      'startShell(PtyType.XTERM)',
      'sftpUpload(',
      'sftpDownload(',
      'connectWithKeyViaJump(',
      'openLocalForward(',
      'setAgentForwarding(true)',
      "execute('ssh-add -L')",
    ]) {
      expect(runner).toContain(expectation);
    }
  });

  it('builds and uploads the unsigned iOS device app', () => {
    const workflow = read('.github/workflows/ci.yml');
    const builder = read('scripts/build-ios-app.sh');
    const appDelegate = read('ios/HerdR/AppDelegate.swift');
    expect(appDelegate).toContain('internal import Expo');
    expect(appDelegate).not.toMatch(/^import Expo$/m);
    expect(appDelegate).toContain('class AppDelegate: ExpoAppDelegate');
    expect(appDelegate).toContain('ExpoReactNativeFactory(delegate: delegate)');
    expect(appDelegate).toContain('class ReactNativeDelegate: ExpoReactNativeFactoryDelegate');
    expect(appDelegate).toContain('return super.application(');
    expect(appDelegate).toContain('RCTLinkingManager.application');
    expect(appDelegate).toContain('bridge.bundleURL ?? bundleURL()');
    expect(appDelegate).toContain('forBundleRoot: ".expo/.virtual-metro-entry"');
    expect(appDelegate).not.toContain('let factory = RCTReactNativeFactory(delegate: delegate)');
    expect(workflow).toContain('name: iOS unsigned compile check');
    expect(workflow).toContain('Compile and validate unsigned iOS device app');
    expect(workflow).toContain('scripts/build-ios-app.sh');
    expect(workflow).toContain('--unsigned');
    expect(builder).toContain('-configuration Release');
    expect(builder).toContain('-sdk iphoneos');
    expect(builder).toContain('-destination generic/platform=iOS');
    expect(builder).toContain('CODE_SIGNING_ALLOWED=NO');
    expect(builder).toContain('Release-iphoneos/HerdR.app');
    expect(builder).toContain('[[ -f "$app_path/main.jsbundle" ]]');
    expect(workflow).toContain('if-no-files-found: error');
    expect(workflow).toContain('name: whip-ios-unsigned-compile-only');
    expect(workflow).not.toContain('if: always()');
  });
});
