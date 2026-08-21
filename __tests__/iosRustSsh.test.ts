import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve(__dirname, '..');
const uniffiRoot = resolve(projectRoot, 'packages/react-native-russh');
const whipAdapterRoot = resolve(projectRoot, 'packages/react-native-whip-ssh');
const readProject = (path: string) =>
  readFileSync(resolve(projectRoot, path), 'utf8');
const readUniffi = (path: string) =>
  readFileSync(resolve(uniffiRoot, path), 'utf8');
const readWhipAdapter = (path: string) =>
  readFileSync(resolve(whipAdapterRoot, path), 'utf8');

describe('UniFFI SSH integration', () => {
  it('pins matching published UniFFI React Native packages', () => {
    const rootPackage = JSON.parse(readProject('package.json'));
    const modulePackage = JSON.parse(readUniffi('package.json'));

    expect(rootPackage.dependencies['uniffi-bindgen-react-native']).toBe(
      '0.31.0-3',
    );
    expect(rootPackage.dependencies['@ubjs/core']).toBe('0.31.0-3');
    expect(rootPackage.dependencies['react-native-whip-ssh']).toBe(
      'file:packages/react-native-whip-ssh',
    );
    expect(rootPackage.dependencies['react-native-russh']).toBe(
      'file:packages/react-native-russh',
    );
    expect(
      rootPackage.dependencies['@dylankenneally/react-native-ssh-sftp'],
    ).toBeUndefined();
    expect(modulePackage.dependencies).toMatchObject({
      '@ubjs/core': '0.31.0-3',
      'uniffi-bindgen-react-native': '0.31.0-3',
    });
  });

  it('keeps the public transport generic and Whip protocols in a private adapter', () => {
    const rootPackage = JSON.parse(readProject('package.json'));
    const modulePackage = JSON.parse(readUniffi('package.json'));
    const moduleConfig = readUniffi('react-native.config.js');
    const javascript = readUniffi('lib/sshclient.js');
    const declarations = readUniffi('lib/sshclient.d.ts');
    const adapterPackage = JSON.parse(
      readFileSync(resolve(whipAdapterRoot, 'package.json'), 'utf8'),
    );
    const adapter = readFileSync(
      resolve(whipAdapterRoot, 'lib/sshclient.js'),
      'utf8',
    );

    expect(
      existsSync(resolve(projectRoot, 'packages/react-native-ssh-sftp')),
    ).toBe(false);
    expect(existsSync(resolve(projectRoot, 'react-native.config.js'))).toBe(
      false,
    );
    expect(modulePackage.main).toBe('lib/sshclient.js');
    expect(modulePackage['react-native']).toBe('lib/sshclient.js');
    expect(modulePackage.types).toBe('lib/sshclient.d.ts');
    expect(rootPackage.expo.doctor.reactNativeDirectoryCheck.exclude).toContain(
      'react-native-russh',
    );
    expect(moduleConfig).toContain("sourceDir: './android'");
    expect(javascript).toContain("require('../src').default");
    expect(javascript).not.toMatch(/Herdr|herdr|pairHost/);
    expect(declarations).not.toMatch(/Herdr|herdr|PairHost|pairHost/);
    expect(adapterPackage.private).toBe(true);
    expect(adapterPackage.dependencies['react-native-russh']).toBe(
      'file:../react-native-russh',
    );
    expect(adapterPackage.dependencies).toMatchObject({
      '@ubjs/core': '0.31.0-3',
      'uniffi-bindgen-react-native': '0.31.0-3',
    });
    expect(adapter).toContain(
      "import BaseSSHClient, { PtyType } from 'react-native-russh'",
    );
    expect(adapter).toContain('class SSHClient extends BaseSSHClient');
    expect(adapter).not.toContain("require('../../react-native-russh/src')");
    expect(adapter).toContain("require('../src').default");
    expect(adapter).toContain('pairHost(code, publicKey, deviceName)');
    expect(adapter).toContain('openLengthPrefixedUnixSocketChannel(');
    expect(adapter).toContain('this.openExecChannel(command, event =>');
    expect(adapter).toContain(
      'return this.requestUnixSocket(socketPath, request)',
    );
    expect(adapter).toContain(
      'return this.openUnixSocketChannel(socketPath, event =>',
    );
    expect(existsSync(resolve(uniffiRoot, 'rust/src/herdr_codec.rs'))).toBe(
      false,
    );
    expect(existsSync(resolve(uniffiRoot, 'rust/src/pairing.rs'))).toBe(false);
    expect(
      existsSync(resolve(whipAdapterRoot, 'lib/herdr-codec.js')),
    ).toBe(true);
    expect(existsSync(resolve(whipAdapterRoot, 'rust/src/pairing.rs'))).toBe(
      true,
    );
    expect(javascript).not.toContain("require('react-native')");
    expect(javascript).not.toContain('Platform.OS');
    expect(javascript).not.toContain('legacySSHClient');
  });

  it('generates a TurboModule, bindings, podspec, and ARM64 XCFramework', () => {
    const config = readUniffi('ubrn.config.yaml');
    const podspec = readUniffi('ReactNativeRussh.podspec');
    const entrypoint = readUniffi('src/generated-entry.tsx');

    expect(config).toContain('aarch64-apple-ios');
    expect(config).toContain('aarch64-apple-ios-sim');
    expect(config).not.toContain('x86_64-apple-ios');
    expect(config).toContain('spec: ReactNativeRusshSpec');
    expect(podspec).toContain(
      's.vendored_frameworks = "build/ReactNativeRussh.xcframework"',
    );
    expect(entrypoint).toContain('installer.installRustCrate()');
  });

  it('exports generic synchronous, asynchronous, event, and shutdown entry points from Rust', () => {
    const rust = readUniffi('rust/src/lib.rs');
    const generated = readUniffi('src/generated/react_native_russh.ts');

    expect(rust).toContain('uniffi::setup_scaffolding!();');
    expect(rust).toContain('#[uniffi::export(with_foreign)]');
    expect(rust).toContain('pub trait ReactNativeRusshEventSink');
    expect(rust).toContain('pub fn call(request_json: String) -> String');
    expect(rust).toContain(
      'pub async fn call_async(request_json: String) -> String',
    );
    expect(rust).toContain('runtime.spawn(process_json_for_lifecycle');
    expect(rust).toContain('pub fn shutdown()');
    expect(rust).toContain('pub fn write_shell_input(');
    expect(rust).toContain('pub fn write_unix_socket_channel(');
    expect(rust).toContain(
      'pub fn write_length_prefixed_unix_socket_channel(',
    );
    expect(rust).toContain('pub fn write_exec_channel(');
    expect(rust).toContain('fn unix_socket_channel_data(');
    expect(rust).toContain('fn exec_channel_data(');
    expect(rust).not.toMatch(/Herdr|herdr|pairHost|pair_host/);
    expect(generated).toContain(
      'export function call(requestJson: string): string',
    );
    expect(generated).toContain('export async function callAsync(');
    expect(generated).toContain('export function setEventSink(');
    expect(generated).toContain('bytes: ArrayBuffer');
    expect(generated).toContain('export function writeUnixSocketChannel(');
    expect(generated).toContain(
      'export function writeLengthPrefixedUnixSocketChannel(',
    );
    expect(generated).toContain('export function writeExecChannel(');
    expect(generated).toContain('unixSocketChannelData(');
    expect(generated).toContain('execChannelData(');
  });

  it('exports concurrent OpenSSH Unix-socket channels from the public facade', () => {
    const adapter = readUniffi('src/index.ts');
    const declarations = readUniffi('lib/sshclient.d.ts');
    const rust = readUniffi('rust/src/lib.rs');

    expect(adapter).toContain('openUnixSocketChannel(');
    expect(adapter).toContain(
      'writeUnixSocketChannelRust(key, channelId, bytes)',
    );
    expect(adapter).toContain('requestUnixSocket(');
    expect(adapter).toContain('openLengthPrefixedUnixSocketChannel(');
    expect(adapter).toContain('openExecChannel(');
    expect(declarations).toContain(
      'export declare class OpenSSHUnixSocketChannel',
    );
    expect(declarations).toContain('openUnixSocketChannel(');
    expect(declarations).toContain('requestUnixSocket(');
    expect(declarations).toContain(
      'export declare class OpenSSHLengthPrefixedUnixSocketChannel',
    );
    expect(declarations).toContain(
      'export declare class OpenSSHExecChannel',
    );
    expect(rust).toContain('channel_open_direct_streamlocal(socket_path)');
    expect(rust).toContain('type UnixSocketChannels');
    expect(rust).toContain('UNIX_SOCKET_CHANNELS');
    expect(rust).toContain('max_response_bytes');
  });

  it('keeps product terminal traffic in the private codec', () => {
    const adapter = readUniffi('src/index.ts');
    const rust = readUniffi('rust/src/lib.rs');
    const sshClient = readUniffi('lib/sshclient.js');
    const privateAdapter = readWhipAdapter('lib/sshclient.js');
    const codec = readWhipAdapter('lib/herdr-codec.js');

    expect(adapter).toContain('writeShellInput(key, data)');
    expect(adapter).not.toMatch(/Herdr|herdr/);
    expect(rust).not.toMatch(/Herdr|herdr/);
    expect(privateAdapter).toContain(
      'this._herdrBridge(terminalId).channel.write(input(text))',
    );
    expect(privateAdapter).toContain('bridgeEvent(message, state.terminalId)');
    expect(codec).toContain("kind === 'terminal'");
    expect(codec).toContain('export function decode(');
    expect(sshClient).not.toContain('JSON.parse(p.replace(');
  });

  it('preserves native stream failure reasons and logs fast-path send failures', () => {
    const adapter = readUniffi('src/index.ts');
    const rust = readUniffi('rust/src/lib.rs');

    expect(rust).toContain('remote exec-channel read failed: {error}');
    expect(rust).toContain('remote exec-channel write failed: {error}');
    expect(rust).toContain('remote Unix-socket write failed: {error}');
    expect(rust).toContain('"reason": reason');
    expect(adapter).toContain(
      'console.error(`[ReactNativeRussh] ${operation} failed: ${error}`)',
    );
    expect(adapter).toContain('writeExecChannelRust(key, channelId, bytes)');
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
    'openLocalForward',
    'closeLocalForward',
    'openUnixSocketChannel',
    'writeUnixSocketChannel',
    'closeUnixSocketChannel',
    'requestUnixSocket',
    'openLengthPrefixedUnixSocketChannel',
    'writeLengthPrefixedUnixSocketChannel',
    'openExecChannel',
    'writeExecChannel',
    'closeExecChannel',
  ])('adapts the existing %s JavaScript contract', operation => {
    expect(readUniffi('src/index.ts')).toContain(`${operation}(`);
  });

  it.each([
    'requestHerdrApi',
    'startHerdrEventStream',
    'writeHerdrEventStream',
    'closeHerdrEventStream',
    'prepareHerdrBridge',
    'startHerdrBridge',
    'herdrBridgeInput',
    'herdrBridgeResize',
    'herdrBridgeScroll',
    'closeHerdrBridge',
    'closeAllHerdrBridges',
    'startHerdrCommandStream',
    'writeHerdrCommandStream',
    'closeHerdrCommandStream',
  ])('keeps the product-level %s method in the private adapter', operation => {
    const adapter = readFileSync(
      resolve(whipAdapterRoot, 'lib/sshclient.js'),
      'utf8',
    );
    expect(adapter).toContain(`${operation}(`);
    expect(readUniffi('src/index.ts')).not.toContain(`${operation}(`);
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
    expect(build).toContain(
      'export PATH="$root_dir/node_modules/.bin:$build_path"',
    );
    expect(build).not.toContain(
      'export PATH="$root_dir/node_modules/.bin:$HOME/.cargo/bin:$PATH"',
    );
    expect(build).toContain('IPHONEOS_DEPLOYMENT_TARGET');
    expect(build).toContain('ubrn build ios');
    expect(build).toContain('packages/react-native-whip-ssh');
    expect(build).toContain('--and-generate');
    expect(build).toContain('--no-sim');
  });

  it('cleans up the Rust event sink and process-wide transport during hot reload', () => {
    const adapter = readUniffi('src/index.ts');
    const rust = readUniffi('rust/src/lib.rs');

    expect(adapter).toContain('clearEventSink();');
    expect(adapter).toContain('shutdownRust();');
    expect(rust).toContain('async fn shutdown_all()');
  });

  it('retains transport safety bounds and staged SFTP transfers', () => {
    const rust = readUniffi('rust/src/lib.rs');

    expect(rust).toContain('CONTROL_QUEUE_CAPACITY');
    expect(rust).toContain('EXECUTE_OUTPUT_LIMIT');
    expect(rust).toContain('.russh-part-');
    expect(rust).toContain('tunnel_cancel.changed()');
  });
});
