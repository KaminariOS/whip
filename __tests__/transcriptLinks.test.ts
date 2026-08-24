import {
  resolveTranscriptFilePath,
  transcriptFileLinkTarget,
} from '../src/lib/transcriptLinks';

describe('transcript file links', () => {
  it('parses Codex absolute paths with line and column suffixes', () => {
    expect(transcriptFileLinkTarget('/home/me/repo/src/App.tsx:129:7')).toEqual({
      path: '/home/me/repo/src/App.tsx',
      line: 129,
      column: 7,
    });
  });

  it('resolves relative OpenCode paths against the transcript directory', () => {
    expect(transcriptFileLinkTarget('../shared/App.tsx#L12C4', '/home/me/repo/src')).toEqual({
      path: '/home/me/repo/shared/App.tsx',
      line: 12,
      column: 4,
    });
  });

  it('accepts file URLs and decodes escaped filenames', () => {
    expect(transcriptFileLinkTarget('file:///home/me/My%20Project/README.md#L8')).toEqual({
      path: '/home/me/My Project/README.md',
      line: 8,
    });
  });

  it('leaves web links and document anchors to their normal handlers', () => {
    expect(transcriptFileLinkTarget('https://example.com/file.ts:12')).toBeNull();
    expect(transcriptFileLinkTarget('mailto:hello@example.com')).toBeNull();
    expect(transcriptFileLinkTarget('#installation')).toBeNull();
  });

  it('retains relative paths when no transcript directory is known', () => {
    expect(transcriptFileLinkTarget('src/App.tsx:20')).toEqual({
      path: 'src/App.tsx',
      line: 20,
    });
    expect(resolveTranscriptFilePath('src/App.tsx', '/work/project')).toBe('/work/project/src/App.tsx');
  });
});
