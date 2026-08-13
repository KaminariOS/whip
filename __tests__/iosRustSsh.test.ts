import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const packageRoot = resolve(__dirname, '../packages/react-native-ssh-sftp');
const read = (path: string) => readFileSync(resolve(packageRoot, path), 'utf8');
const readProject = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('iOS Rust SSH integration', () => {
  it('builds only the Rust bridge and cannot fall back to NMSSH', () => {
    const podspec = read('RNSSHClient.podspec');
    const javascript = read('lib/sshclient.js');

    expect(podspec).toContain("s.source_files     = 'ios/RNSSHRustClient.{h,m}'");
    expect(podspec).not.toContain("s.dependency 'NMSSH'");
    expect(podspec).toContain('Build Rust SSH transport');
    expect(javascript).toContain(
      "const RNSSHClient = Platform.OS === 'ios' ? RNSSHRustClient : legacySSHClient;",
    );
  });

  it('enables Expo module autolinking in the native iOS project', () => {
    const podfile = readProject('ios/Podfile');

    expect(podfile).toContain("'scripts/autolinking'");
    expect(podfile).toContain('use_expo_modules!');
    expect(podfile).toContain("platform :ios, '16.4'");
  });

  it.each([
    'setKnownHosts',
    'getKeyDetails',
    'generateKeyPair',
    'connectToHost',
    'connectToHostByPasswordViaJump',
    'connectToHostByKeyViaJump',
    'setAgentForwarding',
    'execute',
    'startShell',
    'writeToShell',
    'resizeShell',
    'closeShell',
    'measureHostLatency',
    'getRemoteHome',
    'disconnect',
    'connectSFTP',
    'sftpLs',
    'sftpRename',
    'sftpMkdir',
    'sftpRm',
    'sftpRmdir',
    'sftpChmod',
    'sftpUpload',
    'sftpDownload',
    'sftpCancelUpload',
    'sftpCancelDownload',
    'disconnectSFTP',
    'prepareHerdrBridge',
    'startHerdrBridge',
    'herdrBridgeInput',
    'herdrBridgeResize',
    'herdrBridgeScroll',
    'closeHerdrBridge',
    'closeAllHerdrBridges',
    'openLocalForward',
    'closeLocalForward',
    'requestHerdrApi',
    'startHerdrEventStream',
    'startHerdrCommandStream',
    'writeHerdrCommandStream',
    'closeHerdrCommandStream',
  ])('exports the %s native operation', operation => {
    const bridge = read('ios/RNSSHRustClient.m');
    expect(
      bridge.includes(`RCT_EXPORT_METHOD(${operation}`)
      || bridge.includes(`SIMPLE_SFTP_METHOD(${operation},`),
    ).toBe(true);
  });

  it('does not retain Android-only guards for shared SSH features', () => {
    const javascript = read('lib/sshclient.js');

    expect(javascript).not.toContain('SSH agent forwarding is not available in the iOS Rust backend');
    expect(javascript).not.toContain('Herdr remote-client-bridge is currently Android-only');
  });

  it('cross-compiles the active simulator or device architectures', () => {
    const buildScript = read('rust/build-ios.sh');
    const xcframeworkScript = read('rust/build-xcframework.sh');

    expect(buildScript).toContain('aarch64-apple-ios');
    expect(buildScript).toContain('aarch64-apple-ios-sim');
    expect(buildScript).toContain('x86_64-apple-ios');
    expect(buildScript).toContain('xcrun lipo -create');
    expect(buildScript).not.toContain('rustup target add "$target"');
    expect(xcframeworkScript).toContain('xcodebuild -create-xcframework');
  });

  it('does not block the React Native method queue for network operations', () => {
    const bridge = read('ios/RNSSHRustClient.m');
    const header = read('rust/include/whip_ssh.h');

    expect(header).toContain('whip_ssh_call_async');
    expect(bridge).toContain('callOperationAsync:@"execute"');
    expect(bridge).toContain('finishAsync:@"sftpUpload"');
    expect(bridge).toContain('callOperation:@"sftpCancelUpload"');
    expect(bridge).toContain('dispatch_sync(dispatch_get_main_queue(), emit)');
  });

  it('shuts down process-wide Rust state when React Native invalidates the module', () => {
    const bridge = read('ios/RNSSHRustClient.m');
    const rust = read('rust/src/lib.rs');

    expect(bridge).toContain('- (void)invalidate');
    expect(bridge).toContain('whip_ssh_shutdown();');
    expect(rust).toContain('async fn shutdown_all()');
  });

  it('bounds queues/output and stages SFTP transfers before rename', () => {
    const rust = read('rust/src/lib.rs');

    expect(rust).toContain('CONTROL_QUEUE_CAPACITY');
    expect(rust).toContain('EXECUTE_OUTPUT_LIMIT');
    expect(rust).toContain('.whip-part-');
    expect(rust).toContain('tunnel_cancel.changed()');
  });
});
