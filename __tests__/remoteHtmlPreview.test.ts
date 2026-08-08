import {
  parseRemoteHtmlPreviewStart,
  remoteHtmlPreviewPageUrl,
  remoteHtmlPreviewStartCommand,
  remoteHtmlPreviewStopCommand,
} from '../src/lib/remoteHtmlPreview';

describe('remote HTML preview server', () => {
  it('quotes the remote directory and binds Python to loopback on an OS-selected port', () => {
    const command = remoteHtmlPreviewStartCommand("/srv/site's $draft", 'safe-token');

    expect(command).toContain('python3 -c');
    expect(command).toContain('("127.0.0.1", 0)');
    expect(command).toContain("'/srv/site'\"'\"'s $draft'");
    expect(command).toContain('nohup');
    expect(command).toContain('python3 is not installed on the remote host');
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
    expect(remoteHtmlPreviewStopCommand(process)).toContain('kill 8123');
  });

  it('surfaces startup failures from the remote host', () => {
    expect(() => parseRemoteHtmlPreviewStart(
      '__WHIP_HTML_PREVIEW_ERROR__:python3 is not installed on the remote host\r\n',
      'preview-2',
    )).toThrow('python3 is not installed on the remote host');
  });
});
