import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readSource = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('terminal input composer', () => {
  it('opens an editable multiline buffer from a chat bubble tool', () => {
    const screen = readSource('src/components/TerminalScreen.tsx');

    expect(screen).toContain("if (control === 'compose')");
    expect(screen).toContain('<MessageCircle size={TERMINAL_ICON_SIZE}');
    expect(screen).toContain('const [composeText, setComposeText] = useState');
    expect(screen).toContain('multiline');
    expect(screen).toContain('onInteraction?.(activeTargetRef.current)');
    expect(screen).not.toContain('disabled={!composeText.trim() && composeAttachments.length === 0}');
  });

  it('sends Enter when the composer is empty', () => {
    const screen = readSource('src/components/TerminalScreen.tsx');

    expect(screen).toContain("const ENTER_INPUT = '\\r';");
    expect(screen).toContain("enter: ['ENTER', ENTER_INPUT, 'text']");
    expect(screen).toContain('if (!submitted) {\n      sendInput(ENTER_INPUT);\n      return;\n    }');
  });

  it('uses xterm paste semantics without pressing Enter after the composed input', () => {
    const assets = readSource('scripts/sync-terminal-assets.mjs');
    const screen = readSource('src/components/TerminalScreen.tsx');
    const renderer = readSource('src/components/TerminalRendererHost.tsx');

    expect(assets).toContain("window.herdrSubmit = data => {");
    expect(assets).toContain('terminal.paste(data);');
    expect(assets).toContain('const value = bufferedInput;');
    expect(assets).toContain("send({ type: 'buffered-submit', data: value });");
    expect(renderer).toContain("message.type === 'buffered-submit'");
    expect(renderer).toContain('entry.target.client.writeToTerminal(entry.target.session.terminalId, message.data)');
    expect(screen).not.toContain("writeInput('\\r'");
  });

  it('retains an unsent draft when the composer closes', () => {
    const screen = readSource('src/components/TerminalScreen.tsx');
    const closeCompose = screen.slice(
      screen.indexOf('const closeCompose = async () => {'),
      screen.indexOf('const submitCompose = () => {'),
    );

    expect(closeCompose).not.toContain("setComposeText('')");
    expect(screen).toContain("setComposeText('');");
  });

  it('does not close the composer when live scroll metadata changes', () => {
    const screen = readSource('src/components/TerminalScreen.tsx');
    const terminalReset = screen.slice(
      screen.indexOf('useEffect(() => {\n    setError(null);'),
      screen.indexOf('useEffect(() => {\n    setScrollPosition(activeTarget?.scroll);'),
    );

    expect(terminalReset).toContain('setComposeOpen(false)');
    expect(terminalReset).not.toContain('activeTarget?.scroll');
    expect(screen).toContain(
      'useEffect(() => {\n    setScrollPosition(activeTarget?.scroll);\n  }, [activeTarget?.key, activeTarget?.scroll]);',
    );
  });

  it('portals the composer above the terminal and prevents touch fallthrough', () => {
    const screen = readSource('src/components/TerminalScreen.tsx');
    const composer = screen.slice(
      screen.indexOf('{composeOpen && !composeExpanded && ('),
      screen.indexOf('<ScrollView', screen.indexOf('{composeOpen && !composeExpanded && (')),
    );

    expect(screen).toContain("import { Portal } from '@rn-primitives/portal'");
    expect(composer).toContain('<Portal name={`terminal-composer-${terminalId}`}>');
    expect(composer).toContain('<View pointerEvents="box-none" style={StyleSheet.absoluteFill}>');
    expect(composer).toContain('className="absolute inset-x-0 border-t');
    expect(composer).toContain('bottom: TERMINAL_CONTROL_BAR_HEIGHT + bottomSafeAreaInset');
    expect(composer).not.toContain('bottom-full');
    expect(screen).toContain("pointerEvents={composeOpen ? 'none' : 'auto'}");
  });

  it('expands long drafts into a full-screen editor without duplicating draft state', () => {
    const screen = readSource('src/components/TerminalScreen.tsx');

    expect(screen).toContain('const [composeExpanded, setComposeExpanded] = useState(false)');
    expect(screen).toContain("accessibilityLabel={t('terminal.expandComposer')}");
    expect(screen).toContain('<Maximize2 size={17}');
    expect(screen).toContain('onRequestClose={collapseCompose}');
    expect(screen).toContain("accessibilityLabel={t('terminal.collapseComposer')}");
    expect(screen).toContain("{t('terminal.expandedComposerTitle')}");
    expect(screen).toContain('setKeyboardEnabled(true)');
    expect(screen).toContain("t('terminal.composeCharacterCount'");
    expect(screen.match(/value=\{composeText\}/g)).toHaveLength(2);
    expect(screen.match(/onChangeText=\{value => \{/g)).toHaveLength(2);
  });
});
