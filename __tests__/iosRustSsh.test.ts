import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve(__dirname, '..');
const legacyRoot = resolve(projectRoot, 'packages/react-native-ssh-sftp');
const uniffiRoot = resolve(projectRoot, 'packages/react-native-whip-ssh');
const readProject = (path: string) => readFileSync(resolve(projectRoot, path), 'utf8');
const readLegacy = (path: string) => readFileSync(resolve(legacyRoot, path), 'utf8');
const readUniffi = (path: string) => readFileSync(resolve(uniffiRoot, path), 'utf8');

describe('UniFFI SSH integration', () => {
  it('pins matching published UniFFI React Native packages', () => {
    const rootPackage = JSON.parse(readProject('package.json'));
    const modulePackage = JSON.parse(readUniffi('package.json'));

    expect(rootPackage.dependencies['uniffi-bindgen-react-native']).toBe('0.31.0-3');
    expect(rootPackage.dependencies['@ubjs/core']).toBe('0.31.0-3');
    expect(rootPackage.dependencies['react-native-whip-ssh']).toBe(
      'file:packages/react-native-whip-ssh',
    );
    expect(modulePackage.dependencies).toMatchObject({
      '@ubjs/core': '0.31.0-3',
      'uniffi-bindgen-react-native': '0.31.0-3',
    });
  });

  it('uses the UniFFI package on both mobile platforms and disables legacy native linking', () => {
    const rootConfig = readProject('react-native.config.js');
    const moduleConfig = readUniffi('react-native.config.js');
    const javascript = readLegacy('lib/sshclient.js');

    expect(rootConfig).toContain("'@dylankenneally/react-native-ssh-sftp'");
    expect(rootConfig).toContain('ios: null');
    expect(rootConfig).toContain('android: null');
    expect(moduleConfig).toContain("sourceDir: './android'");
    expect(javascript).toContain("require('react-native-whip-ssh').default");
    expect(javascript).not.toContain("require('react-native')");
    expect(javascript).not.toContain('Platform.OS');
    expect(javascript).not.toContain('legacySSHClient');
  });

  it('generates a TurboModule, bindings, podspec, and ARM64 XCFramework', () => {
    const config = readUniffi('ubrn.config.yaml');
    const podspec = readUniffi('WhipSsh.podspec');
    const entrypoint = readUniffi('src/generated-entry.tsx');

    expect(config).toContain('aarch64-apple-ios');
    expect(config).not.toContain('aarch64-apple-ios-sim');
    expect(config).not.toContain('x86_64-apple-ios');
    expect(config).toContain('spec: WhipSshSpec');
    expect(podspec).toContain('s.vendored_frameworks = "build/WhipSsh.xcframework"');
    expect(entrypoint).toContain('installer.installRustCrate()');
  });

  it('exports generic synchronous, asynchronous, event, and shutdown entry points from Rust', () => {
    const rust = readLegacy('rust/src/lib.rs');
    const generated = readUniffi('src/generated/whip_ssh.ts');

    expect(rust).toContain('uniffi::setup_scaffolding!();');
    expect(rust).toContain('#[uniffi::export(with_foreign)]');
    expect(rust).toContain('pub trait WhipSshEventSink');
    expect(rust).toContain('pub fn call(request_json: String) -> String');
    expect(rust).toContain('pub async fn call_async(request_json: String) -> String');
    expect(rust).toContain('runtime.spawn(process_json_for_lifecycle');
    expect(rust).toContain('pub fn shutdown()');
    expect(rust).toContain('fn terminal_frame(');
    expect(rust).toContain('pub fn herdr_bridge_input_fast(');
    expect(rust).toContain('pub fn herdr_bridge_resize_fast(');
    expect(rust).toContain('pub fn herdr_bridge_scroll_fast(');
    expect(rust).toContain('pub fn write_shell_input(');
    expect(generated).toContain('export function call(requestJson: string): string');
    expect(generated).toContain('export async function callAsync(');
    expect(generated).toContain('export function setEventSink(');
    expect(generated).toContain('terminalFrame(');
    expect(generated).toContain('bytes: ArrayBuffer');
    expect(generated).toContain('export function herdrBridgeInputFast(');
  });

  it('keeps terminal traffic off the generic JSON dispatcher', () => {
    const adapter = readUniffi('src/index.ts');
    const rust = readLegacy('rust/src/lib.rs');
    const sshClient = readLegacy('lib/sshclient.js');

    expect(adapter).toContain('writeShellInput(key, data)');
    expect(adapter).toContain('herdrBridgeInputFast(key, terminalId, text)');
    expect(adapter).toContain('herdrBridgeResizeFast(');
    expect(adapter).toContain('herdrBridgeScrollFast(key, terminalId, up, lines)');
    expect(adapter).toContain("dispatchEvent('HerdrBridge'");
    expect(rust).toContain('sink.terminal_frame(');
    expect(sshClient).not.toContain('JSON.parse(p.replace(');
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
    'writeHerdrEventStream',
    'closeHerdrEventStream',
    'startHerdrCommandStream',
    'writeHerdrCommandStream',
    'closeHerdrCommandStream',
  ])('adapts the existing %s JavaScript contract', operation => {
    expect(readUniffi('src/index.ts')).toContain(`${operation}(`);
  });

  it('builds only current ARM architectures in EAS and supports explicit local generation', () => {
    const prepare = readProject('scripts/prepare-eas-ios.sh');
    const build = readProject('scripts/build-ios-uniffi.sh');

    expect(prepare).toContain('rustup target add aarch64-apple-ios');
    expect(prepare).not.toContain('aarch64-apple-ios-sim');
    expect(prepare).not.toContain('x86_64-apple-ios');
    expect(build).toContain('WHIP_BUILD_IOS_UNIFFI');
    expect(build).toContain('"$(uname -s)" != "Darwin"');
    expect(build).toContain(
      '[[ -n "${IN_NIX_SHELL:-}" && "$(uname -s)" == "Darwin" ]]',
    );
    expect(build).toContain(
      'build_path="/usr/bin:/bin:/usr/sbin:/sbin:$build_path"',
    );
    expect(build).toContain(
      'DEVELOPER_DIR="${WHIP_DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"',
    );
    expect(build).toContain('unset SDKROOT');
    expect(build).toContain('elif [[ -z "${IN_NIX_SHELL:-}" ]]');
    expect(build).toContain('export PATH="$root_dir/node_modules/.bin:$build_path"');
    expect(build).not.toContain(
      'export PATH="$root_dir/node_modules/.bin:$HOME/.cargo/bin:$PATH"',
    );
    expect(build).toContain('IPHONEOS_DEPLOYMENT_TARGET');
    expect(build).toContain('ubrn build ios');
    expect(build).toContain('--and-generate');
    expect(build).toContain('--no-sim');
  });

  it('cleans up the Rust event sink and process-wide transport during hot reload', () => {
    const adapter = readUniffi('src/index.ts');
    const rust = readLegacy('rust/src/lib.rs');

    expect(adapter).toContain('clearEventSink();');
    expect(adapter).toContain('shutdownRust();');
    expect(rust).toContain('async fn shutdown_all()');
  });

  it('retains transport safety bounds and staged SFTP transfers', () => {
    const rust = readLegacy('rust/src/lib.rs');

    expect(rust).toContain('CONTROL_QUEUE_CAPACITY');
    expect(rust).toContain('EXECUTE_OUTPUT_LIMIT');
    expect(rust).toContain('.whip-part-');
    expect(rust).toContain('tunnel_cancel.changed()');
  });
});
