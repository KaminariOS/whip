import { buildSandboxedHtmlPreview } from '../src/lib/htmlPreview';

describe('sandboxed HTML previews', () => {
  it('escapes remote markup into an inert srcdoc document', () => {
    const preview = buildSandboxedHtmlPreview(
      '<h1 title="Fish & chips">Hello</h1><script>alert(1)</script>',
      'unsafe "page".html',
    );

    expect(preview).toContain('sandbox=""');
    expect(preview).toContain("default-src 'none'");
    expect(preview).toContain("script-src 'none'");
    expect(preview).toContain('referrerpolicy="no-referrer"');
    expect(preview).toContain('title="unsafe &quot;page&quot;.html"');
    expect(preview).toContain(
      'srcdoc="&lt;h1 title=&quot;Fish &amp; chips&quot;&gt;Hello&lt;/h1&gt;',
    );
    expect(preview).not.toContain('<script>alert(1)</script>');
  });
});
