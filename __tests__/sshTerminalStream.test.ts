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
    expect(declarations).toContain('startLineShell(ptyType: PtyType');
    expect(android).toContain('public void startLineShell');
    expect(android).toContain('client._bufferedReader.readLine()');
    expect(android).toContain('client._bufferedReader.read(chars)');
  });

  test('Herdr uses the atomic line stream and requests a post-open redraw', () => {
    const client = readFileSync(resolve(__dirname, '../src/services/HerdrClient.ts'), 'utf8');

    expect(client).toContain('await client.startLineShell(PtyType.XTERM)');
    expect(client).toContain('setTimeout(resolve, 1000)');
    expect(client.match(/client\.resizeShell\(size\.columns, size\.rows\)/g)).toHaveLength(3);
    expect(client.match(/terminalResizeCommand\(size\.columns, size\.rows/g)).toHaveLength(2);
  });
});
