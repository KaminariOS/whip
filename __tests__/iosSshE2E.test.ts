import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('iOS SSH integration wiring', () => {
  it('boots the dedicated runner only when the iOS launch argument enables it', () => {
    const entry = read('index.js');
    expect(entry).toContain("Settings.get('WhipE2EEnabled')");
    expect(entry).toContain("[true, 1, '1', 'YES', 'true'].includes(iosE2EFlag)");
    expect(entry).toContain('IosSshE2EScreen');
  });

  it('launches the same app key that Expo registerRootComponent registers', () => {
    const entry = read('index.js');
    const appDelegate = read('ios/HerdR/AppDelegate.swift');
    expect(entry).toContain("import { registerRootComponent } from 'expo'");
    expect(entry).toContain('registerRootComponent(RootComponent)');
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
    expect(workflow).toContain('name: iOS unsigned device build');
    expect(workflow).toContain('Build unsigned iOS device app');
    expect(workflow).toContain('-configuration Release');
    expect(workflow).toContain('-sdk iphoneos');
    expect(workflow).toContain('-destination "generic/platform=iOS"');
    expect(workflow).toContain('CODE_SIGNING_ALLOWED=NO');
    expect(workflow).toContain('Release-iphoneos/HerdR.app');
    expect(workflow).toContain('test -f "$app_path/main.jsbundle"');
    expect(workflow).toContain('if-no-files-found: warn');
    expect(workflow).toContain('name: whip-ios-app');
    expect(workflow).toContain('if: always()');
  });
});
