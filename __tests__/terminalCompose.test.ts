import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readSource = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('terminal input composer', () => {
  it('opens an editable multiline buffer from a chat bubble tool', () => {
    const screen = readSource('src/components/TerminalScreen.tsx');

    expect(screen).toContain("if (control === 'compose')");
    expect(screen).toContain('<MessageCircle size={16}');
    expect(screen).toContain('const [composeText, setComposeText] = useState');
    expect(screen).toContain('multiline');
    expect(screen).toContain('onChangeText={setComposeText}');
    expect(screen).toContain('disabled={!composeText.trim() && composeAttachments.length === 0}');
  });

  it('uses xterm paste semantics without pressing Enter after the composed input', () => {
    const assets = readSource('scripts/sync-terminal-assets.mjs');
    const screen = readSource('src/components/TerminalScreen.tsx');

    expect(assets).toContain("window.herdrSubmit = data => {");
    expect(assets).toContain('terminal.paste(data);');
    expect(assets).toContain('const value = bufferedInput;');
    expect(assets).toContain("send({ type: 'buffered-submit', data: value });");
    expect(screen).toContain("message.type === 'buffered-submit'");
    expect(screen).toContain('await writeInput(message.data, false);');
    expect(screen).not.toContain("await writeInput('\\r', false);");
  });

  it('retains an unsent draft when the composer closes', () => {
    const screen = readSource('src/components/TerminalScreen.tsx');
    const closeCompose = screen.slice(
      screen.indexOf('const closeCompose = () => {'),
      screen.indexOf('const submitCompose = () => {'),
    );

    expect(closeCompose).not.toContain("setComposeText('')");
    expect(screen).toContain("setComposeText('');");
  });
});
