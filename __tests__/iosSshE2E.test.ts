import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('iOS simulator SSH end-to-end matrix', () => {
  it('boots the dedicated runner only when the iOS launch argument enables it', () => {
    const entry = read('index.js');
    expect(entry).toContain("Settings.get('WhipE2EEnabled')");
    expect(entry).toContain("[true, 1, '1', 'YES', 'true'].includes(iosE2EFlag)");
    expect(entry).toContain('IosSshE2EScreen');
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

  it('runs a real macOS OpenSSH fixture and always retains diagnostics and the unsigned app', () => {
    const workflow = read('.github/workflows/ci.yml');
    const fixture = read('scripts/ios-ssh-e2e-fixture.sh');
    const appDelegate = read('ios/HerdR/AppDelegate.swift');
    expect(fixture).toContain('/usr/sbin/sshd -D');
    expect(fixture).toContain('PasswordAuthentication yes');
    expect(fixture).toContain('username="whipe2e$(uuidgen');
    expect(fixture).toContain('sysadminctl -addUser "$username"');
    expect(fixture).toContain('-password "$password"');
    expect(fixture).toContain('-admin');
    expect(fixture).toContain('dscl . -authonly "$username" "$password"');
    expect(fixture).toContain('sysadminctl -deleteUser "$WHIP_E2E_USER"');
    expect(fixture).not.toContain('dscl . -create');
    expect(fixture).not.toContain('username="$(id -un)"');
    expect(appDelegate).toContain('import Expo');
    expect(appDelegate).toContain('class AppDelegate: ExpoAppDelegate');
    expect(appDelegate).toContain('ExpoReactNativeFactory(delegate: delegate)');
    expect(appDelegate).toContain('class ReactNativeDelegate: ExpoReactNativeFactoryDelegate');
    expect(appDelegate).toContain('return super.application(');
    expect(appDelegate).not.toContain('let factory = RCTReactNativeFactory(delegate: delegate)');
    expect(workflow).toContain('${WHIP_E2E_FIXTURE_DIR:-$RUNNER_TEMP/whip-ios-ssh-fixture}');
    expect(workflow).toContain('Install and run simulator SSH feature matrix');
    expect(workflow).toContain('-configuration Release');
    expect(workflow).toContain('Release-iphonesimulator/HerdR.app');
    expect(workflow).toContain('test -f "$app_path/main.jsbundle"');
    expect(workflow).not.toContain('-configuration Debug');
    expect(workflow).not.toContain('Debug-iphonesimulator/HerdR.app');
    expect(workflow).toContain('whip-ios-ssh-e2e-result.json');
    expect(workflow).toContain('name: whip-ios-simulator-app');
    expect(workflow).toContain('name: whip-ios-ssh-diagnostics');
    expect(workflow).toContain('if: always()');
  });
});
