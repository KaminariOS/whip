import {
  isSshTunnelHost,
  localTunnelUrl,
  terminalWebLinkTarget,
} from '../src/lib/terminalLinks';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const {
  extractTerminalLinks,
}: {
  extractTerminalLinks: (
    rows: Array<{ text: string; isWrapped: boolean }>,
    columns: number,
  ) => string[];
} = require('../scripts/terminal-link-extraction.cjs');

describe('terminal web links', () => {
  it.each([
    'localhost',
    'api.localhost',
    '0.0.0.0',
    '127.0.0.1',
    '127.12.4.8',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.50.2',
    '169.254.10.2',
    '::1',
    'fd12:3456::1',
    'fe80::10',
  ])('routes %s through SSH', hostname => {
    expect(isSshTunnelHost(hostname)).toBe(true);
  });

  it.each(['example.com', '8.8.8.8', '172.32.0.1', '192.169.0.1'])('opens %s directly', hostname => {
    expect(isSshTunnelHost(hostname)).toBe(false);
  });

  it('derives the remote endpoint and preserves the path when tunneling', () => {
    expect(terminalWebLinkTarget('http://localhost:5173/docs?q=one#intro')).toEqual({
      url: 'http://localhost:5173/docs?q=one#intro',
      hostname: 'localhost',
      port: 5173,
      requiresSshTunnel: true,
    });
    expect(localTunnelUrl('http://localhost:5173/docs?q=one#intro', 43127)).toBe(
      'http://localhost:43127/docs?q=one#intro',
    );
    expect(localTunnelUrl('http://192.168.1.4:8080/', 43128)).toBe('http://127.0.0.1:43128/');
  });

  it('uses the protocol default port', () => {
    expect(terminalWebLinkTarget('https://example.com/path').port).toBe(443);
    expect(terminalWebLinkTarget('http://example.com/path').port).toBe(80);
  });

  it('routes every link through the persisted in-app toggle', () => {
    const session = readFileSync(
      resolve(__dirname, '../src/components/SessionScreen.tsx'),
      'utf8',
    );

    expect(session).toContain('checked={terminalPreferences.openLinksInApp}');
    expect(session).toContain('if (!terminalPreferences.openLinksInApp)');
    expect(session).toContain('await Linking.openURL(target.url)');
    expect(session.indexOf('await Linking.openURL(target.url)')).toBeLessThan(
      session.indexOf('const tunnel = await client.openWebTunnel(target.url)'),
    );
  });

  it('extracts a link that xterm soft-wraps onto the next row', () => {
    expect(extractTerminalLinks([
      { text: 'Open https://example.com/a/very/long/', isWrapped: false },
      { text: 'path?with=query', isWrapped: true },
    ], 40)).toEqual([
      'https://example.com/a/very/long/path?with=query',
    ]);
  });

  it('extracts a link hard-wrapped at the terminal edge', () => {
    const firstRow = 'Open https://example.com/a/very/long/';

    expect(extractTerminalLinks([
      { text: firstRow, isWrapped: false },
      { text: 'path?with=query', isWrapped: false },
    ], firstRow.length)).toEqual([
      'https://example.com/a/very/long/path?with=query',
    ]);
  });

  it('extracts a link wrapped inside a terminal UI block', () => {
    expect(extractTerminalLinks([
      { text: '  ┃  https://www.reddit.com/r/herdr/comments/         ', isWrapped: false },
      { text: '  ┃  1v28abf/                                         ', isWrapped: false },
      { text: '  ┃  got_tired_of_installing_herdr_plugins_one_by_    ', isWrapped: false },
      { text: '  ┃  one/                                             ', isWrapped: false },
      { text: '  ┃                                                   ', isWrapped: false },
      { text: '  ┃  Build·DeepSeek V4 Flash Free OpenCode  · max     ', isWrapped: false },
    ], 54)).toContain(
      'https://www.reddit.com/r/herdr/comments/1v28abf/got_tired_of_installing_herdr_plugins_one_by_one/',
    );
  });

  it('extracts a link when a terminal UI replaces its prompt marker with indentation', () => {
    expect(extractTerminalLinks([
      { text: '› https://www.reddit.com/r/theprimeagen/              ', isWrapped: false },
      { text: '  comments/1v1t6pc/                                   ', isWrapped: false },
      { text: '  i_built_a_react_native_terminus_replacement_whip/   ', isWrapped: false },
      { text: '  #lightbox                                           ', isWrapped: false },
      { text: '                                                      ', isWrapped: false },
      { text: '  gpt-5.6-sol high fast · ~/repos/yuanwuzhi/sciflow   ', isWrapped: false },
    ], 54)).toContain(
      'https://www.reddit.com/r/theprimeagen/comments/1v1t6pc/i_built_a_react_native_terminus_replacement_whip/#lightbox',
    );
  });

  it('does not merge ordinary adjacent terminal lines into a link', () => {
    expect(extractTerminalLinks([
      { text: 'Open https://example.com/docs', isWrapped: false },
      { text: 'next-command-output', isWrapped: false },
    ], 80)).toEqual([
      'https://example.com/docs',
    ]);
  });
});
