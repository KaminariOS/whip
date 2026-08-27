import { normalizeRichTextMarkdown } from '../src/lib/richTextMarkdown';

describe('rich text markdown normalization', () => {
  test('converts semantic HTML into native-renderable GitHub Markdown', () => {
    const result = normalizeRichTextMarkdown(`
      <h2>Build result</h2>
      <p>The <strong>release</strong> is <a href="https://example.com/a b">ready</a>.<br>Ship it.</p>
      <ul><li>Android</li><li>iOS &amp; macOS</li></ul>
      <table><tr><th>Target</th><th>Status</th></tr><tr><td>arm64</td><td>Done</td></tr></table>
    `);

    expect(result).toContain('## Build result');
    expect(result).toContain(
      'The **release** is [ready](https://example.com/a%20b).',
    );
    expect(result).toContain('- Android\n- iOS & macOS');
    expect(result).toContain(
      '| Target | Status |\n| --- | --- |\n| arm64 | Done |',
    );
  });

  test('renders HTML code and removes active or unsafe content', () => {
    const unsafeScheme = ['java', 'script:'].join('');
    const result = normalizeRichTextMarkdown(`
      <pre><code class="language-ts">const tag = &quot;&lt;main&gt;&quot;;</code></pre>
      <script>alert('no')</script>
      <p><a href="${unsafeScheme}alert(1)">Unsafe</a> <img alt="tracker" src="data:text/html,hi"></p>
    `);

    expect(result).toContain('```ts\nconst tag = "<main>";\n```');
    expect(result).toContain('Unsafe tracker');
    expect(result).not.toContain(unsafeScheme);
    expect(result).not.toContain("alert('no')");
  });

  test('keeps HTML examples inside existing Markdown code spans and fences', () => {
    const source = 'Use `<section>` here.\n\n```html\n<main>Hello</main>\n```';
    expect(normalizeRichTextMarkdown(source)).toBe(source);
  });

  test('leaves ordinary Markdown untouched', () => {
    const source = '# Result\n\n- one\n- two\n\n`x < y`';
    expect(normalizeRichTextMarkdown(source)).toBe(source);
  });

  test('preserves the Markdown syntax enabled by the native parser', () => {
    const source = [
      '**bold**',
      '',
      '*italic*',
      '',
      '~~deleted~~',
      '',
      '`inline code`',
      '',
      '```rust',
      'fn main() {}',
      '```',
      '',
      '- [ ] incomplete',
      '- [x] complete',
      '',
      '| A | B |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      'H~2~O',
      '',
      'x^2^',
      '',
      '==highlight==',
      '',
      '$E = mc^2$',
      '',
      String.raw`\(a + b\)`,
    ].join('\n');

    expect(normalizeRichTextMarkdown(source)).toBe(
      source.replace(String.raw`\(a + b\)`, '$a + b$'),
    );
  });

  test('converts OpenCode inline math delimiters for the native renderer', () => {
    const source = String.raw`Euler's identity \(e^{i\pi} + 1 = 0\) is compact.`;
    expect(normalizeRichTextMarkdown(source)).toBe(
      String.raw`Euler's identity $e^{i\pi} + 1 = 0$ is compact.`,
    );
  });

  test('does not convert OpenCode math delimiters inside code spans or fences', () => {
    const source = 'Outside \\(x^2\\).\n\nInline: `\\(not_math\\)`\n\n```tex\n\\(also_not_math\\)\n```';
    const expected = 'Outside $x^2$.\n\nInline: `\\(not_math\\)`\n\n```tex\n\\(also_not_math\\)\n```';
    expect(normalizeRichTextMarkdown(source)).toBe(expected);
  });

  test('keeps escaped OpenCode math delimiters literal', () => {
    const source = String.raw`Literal \\(not math\\), math \(x\).`;
    expect(normalizeRichTextMarkdown(source)).toBe(
      String.raw`Literal \\(not math\\), math $x$.`,
    );
  });

  test('keeps math-like text in HTML code elements literal', () => {
    expect(normalizeRichTextMarkdown(String.raw`<code>\(not_math\)</code> and \(x\)`)).toBe(
      '`\\(not_math\\)` and $x$',
    );
  });

  test('does not transform Markdown, HTML, or math delimiters inside code', () => {
    const source = [
      'Inline: `<strong>**bold**</strong> \\(x\\) $y$ H~2~O x^2^ ==mark==`',
      '',
      '```markdown',
      '<em>*italic*</em>',
      String.raw`\(not_math\) and $also_not_math$`,
      '~~deleted~~ H~2~O x^2^ ==highlight==',
      '```',
    ].join('\n');

    expect(normalizeRichTextMarkdown(source)).toBe(source);
  });

  test('does not crash on invalid numeric HTML entities', () => {
    expect(normalizeRichTextMarkdown('<p>Bad: &#999999999;</p>')).toBe(
      'Bad: &#999999999;',
    );
  });
});
