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

  test('Herdr terminals use protocol 16 remote-client-bridge on the primary SSH client', () => {
    const client = readFileSync(resolve(__dirname, '../src/services/HerdrClient.ts'), 'utf8');
    const terminalScreen = readFileSync(resolve(__dirname, '../src/components/TerminalScreen.tsx'), 'utf8');
    const codec = readFileSync(
      resolve(packageRoot, 'android/src/main/java/me/dylankenneally/rnssh/HerdrBridgeCodec.java'),
      'utf8',
    );

    expect(client).toContain('remote-client-bridge');
    expect(client).toContain('this.requireClient().startHerdrBridge');
    expect(client).toContain('this.requireClient().herdrBridgeAttach');
    expect(codec).toContain('ClientMessage::Hello');
    expect(codec).toContain('RenderEncoding::TerminalAnsi');
    expect(codec).toContain('ClientLaunchMode::TerminalAttach');
    expect(terminalScreen).toContain('window.herdrWriteBase64Chunk');
  });
});
