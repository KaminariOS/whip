import {
  parseRemoteHtmlPreviewStart,
  remoteHtmlPreviewPageUrl,
  remoteHtmlPreviewStartCommand,
  remoteHtmlPreviewStopCommand,
} from '../src/lib/remoteHtmlPreview';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('remote HTML preview server', () => {
  it('uses a POSIX shell and binds an available remote server to loopback', () => {
    const command = remoteHtmlPreviewStartCommand("/srv/site's $draft", 'safe-token');

    expect(command).toMatch(/^sh -c /);
    expect(command).toContain('python3 -c');
    expect(command).toContain('node -e');
    expect(command).toContain('("127.0.0.1", 0)');
    expect(command).toContain('server.listen(0, "127.0.0.1"');
    expect(command).toContain('/srv/site');
    expect(command).toContain('$draft');
    expect(command).toContain('nohup');
    expect(command).toContain('Neither python3 nor node is installed on the remote host');
  });

  it('parses the process address and creates an encoded page URL', () => {
    const process = parseRemoteHtmlPreviewStart('8123:49152\r\n', 'preview-1');

    expect(process).toEqual({
      pid: 8123,
      port: 49152,
      portFile: '/tmp/whip-html-preview-preview-1.port',
      logFile: '/tmp/whip-html-preview-preview-1.log',
    });
    expect(remoteHtmlPreviewPageUrl(process.port, 'index draft.html')).toBe(
      'http://127.0.0.1:49152/index%20draft.html',
    );
    expect(remoteHtmlPreviewStopCommand(process)).toMatch(/^sh -c /);
    expect(remoteHtmlPreviewStopCommand(process)).toContain('kill 8123');
  });

  it('surfaces startup failures from the remote host', () => {
    expect(() => parseRemoteHtmlPreviewStart(
      '__WHIP_HTML_PREVIEW_ERROR__:python3 is not installed on the remote host\r\n',
      'preview-2',
    )).toThrow('python3 is not installed on the remote host');
  });

  it('starts through Fish when available and serves the requested directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'whip-html-preview-'));
    const parentShell = existsSync('/run/current-system/sw/bin/fish')
      ? '/run/current-system/sw/bin/fish'
      : 'sh';
    let process: ReturnType<typeof parseRemoteHtmlPreviewStart> | null = null;
    try {
      writeFileSync(join(directory, 'index.html'), '<h1>Whip preview</h1>');
      const output = execFileSync(
        parentShell,
        ['-c', remoteHtmlPreviewStartCommand(directory, 'integration-test')],
        { encoding: 'utf8' },
      );
      process = parseRemoteHtmlPreviewStart(output, 'integration-test');
      const response = await fetch(remoteHtmlPreviewPageUrl(process.port, 'index.html'));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Whip preview');
    } finally {
      if (process) {
        execFileSync(parentShell, ['-c', remoteHtmlPreviewStopCommand(process)]);
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
