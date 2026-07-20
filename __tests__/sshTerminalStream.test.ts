import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Android SSH terminal protocol stream', () => {
  const packageRoot = resolve(__dirname, '../packages/react-native-ssh-sftp');

  test('exposes an application line stream without changing the raw shell path', () => {
    const javascript = readFileSync(resolve(packageRoot, 'lib/sshclient.js'), 'utf8');
    const declarations = readFileSync(resolve(packageRoot, 'lib/sshclient.d.ts'), 'utf8');
    const android = readFileSync(
      resolve(packageRoot, 'android/src/main/java/me/dylankenneally/rnssh/RNSshClientModule.java'),
      'utf8',
    );

    expect(javascript).toContain('startLineShell(ptyType, callback)');
    expect(javascript).toContain('RNSSHClient.startLineShell');
    expect(javascript).toContain('startHerdrEventStream(command, handler, callback)');
    expect(declarations).toContain('startLineShell(ptyType: PtyType');
    expect(android).toContain('public void startLineShell');
    expect(android).toContain('client._bufferedReader.readLine()');
    expect(android).toContain('sendLineShellEvent(key, line)');
    expect(android).toContain('final int chunkSize = 8192');
    expect(android).toContain('client._bufferedReader.read(chars)');
    expect(android).toContain('public void startHerdrEventStream');
  });

  test('subscribes to exec output before starting short-lived remote commands', () => {
    const android = readFileSync(
      resolve(packageRoot, 'android/src/main/java/me/dylankenneally/rnssh/RNSshClientModule.java'),
      'utf8',
    );
    const execute = android.slice(
      android.indexOf('public void execute('),
      android.indexOf('public void startShell('),
    );

    expect(execute.indexOf('channel.getInputStream()')).toBeGreaterThan(-1);
    expect(execute.indexOf('channel.getInputStream()')).toBeLessThan(
      execute.indexOf('channel.connect(SSH_CHANNEL_CONNECT_TIMEOUT_MS)'),
    );
    expect(execute).toContain('if (channel != null) channel.disconnect();');
  });

  test('Herdr terminals use protocol 17 remote-client-bridge on the primary SSH client', () => {
    const client = readFileSync(resolve(__dirname, '../src/services/HerdrClient.ts'), 'utf8');
    const terminalScreen = readFileSync(resolve(__dirname, '../src/components/TerminalScreen.tsx'), 'utf8');
    const codec = readFileSync(
      resolve(packageRoot, 'android/src/main/java/me/dylankenneally/rnssh/HerdrBridgeCodec.java'),
      'utf8',
    );

    expect(client).toContain('remote-client-bridge');
    expect(client).toContain('this.requireClient().startHerdrBridge');
    expect(client).toContain('this.requireClient().prepareHerdrBridge');
    expect(client).toContain('private terminalBridges = new Set<string>()');
    expect(codec).toContain('ClientMessage::Hello');
    expect(codec).toContain('static final int PROTOCOL_VERSION = 17');
    expect(codec).toContain('RenderEncoding::TerminalAnsi');
    expect(codec).toContain('ClientLaunchMode::TerminalAttach');
    expect(terminalScreen).toContain('window.herdrWriteBase64Chunk');
  });

  test('keeps one direct-attach bridge per terminal inside the primary SSH session', () => {
    const javascript = readFileSync(resolve(packageRoot, 'lib/sshclient.js'), 'utf8');
    const android = readFileSync(
      resolve(packageRoot, 'android/src/main/java/me/dylankenneally/rnssh/RNSshClientModule.java'),
      'utf8',
    );

    expect(javascript).toContain('this._herdrBridgeHandlers = new Map()');
    expect(javascript).toContain('RNSSHClient.startHerdrBridge(command, protocol, terminalId, takeover');
    expect(android).toContain('final Map<String, HerdrBridgeConnection> _herdrBridges');
    expect(android).toContain('value.putString("terminalId", terminalId)');
    expect(android).toContain('boolean clientWasReplaced = clientPool.get(key) != client;');
    expect(android).toContain('boolean unusedPrewarm = connection.terminalId == null;');
    expect(android).toContain('Herdr bridge cancelled because the SSH session was replaced');
    expect(android).toContain('Log.d(LOGTAG, "Herdr bridge prewarm ended: " + error.getMessage());');
    expect(android).not.toContain('ChannelExec _herdrBridgeChannel');
  });

  test('detects half-open SSH sessions instead of leaving frozen streams', () => {
    const android = readFileSync(
      resolve(packageRoot, 'android/src/main/java/me/dylankenneally/rnssh/RNSshClientModule.java'),
      'utf8',
    );
    const connect = android.slice(
      android.indexOf('private void connectToHost('),
      android.indexOf('public void execute('),
    );

    expect(android).toContain('SSH_SERVER_ALIVE_INTERVAL_MS = 5_000');
    expect(android).toContain('SSH_SERVER_ALIVE_COUNT_MAX = 3');
    expect(connect).toContain('session.setServerAliveInterval(SSH_SERVER_ALIVE_INTERVAL_MS);');
    expect(connect).toContain('session.setServerAliveCountMax(SSH_SERVER_ALIVE_COUNT_MAX);');
    expect(connect.indexOf('session.setServerAliveInterval')).toBeLessThan(
      connect.indexOf('session.connect(SSH_CONNECT_TIMEOUT_MS)'),
    );
  });

  test('bounds SSH and channel connection setup', () => {
    const android = readFileSync(
      resolve(packageRoot, 'android/src/main/java/me/dylankenneally/rnssh/RNSshClientModule.java'),
      'utf8',
    );

    expect(android).toContain('SSH_CONNECT_TIMEOUT_MS = 10_000');
    expect(android).toContain('SSH_CHANNEL_CONNECT_TIMEOUT_MS = 5_000');
    expect(android).toContain('session.connect(SSH_CONNECT_TIMEOUT_MS);');
    expect(android).not.toContain('session.connect();');
    expect(android).not.toContain('channel.connect();');
  });
});
