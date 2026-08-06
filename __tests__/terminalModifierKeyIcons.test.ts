import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('switches terminal key controls between text and keyboard symbols', () => {
  const screen = readFileSync(
    resolve(__dirname, '../src/components/TerminalScreen.tsx'),
    'utf8',
  );
  const settings = readFileSync(
    resolve(__dirname, '../src/components/SettingsScreen.tsx'),
    'utf8',
  );

  expect(settings).toContain("t('settings.useModifierKeyIcons')");
  expect(settings).toContain('useModifierKeyIcons: value');
  expect(screen).toContain('<TerminalControlIcon icon={ChevronUp}');
  expect(screen).toContain('<TerminalControlIcon icon={ArrowBigUp}');
  expect(screen).toContain('<TerminalControlIcon icon={Option}');
  expect(screen).toContain("esc: { label: '⎋', accessibilityKey: 'terminal.escapeKey' }");
  expect(screen).toContain("tab: { icon: ArrowRightToLine, accessibilityKey: 'terminal.tabKey' }");
  expect(screen).toContain("enter: { icon: CornerDownLeft, accessibilityKey: 'terminal.enterKey' }");
  expect(screen).toContain('icon={icon}');
  expect(screen).toContain("symbolic={!icon && (useIconicKey || key[2] === 'symbol')}");
  expect(screen).toContain("accessibilityLabel={t('terminal.ctrlModifier')}");
  expect(screen).toContain("accessibilityLabel={t('terminal.shiftModifier')}");
  expect(screen).toContain("accessibilityLabel={t('terminal.altModifier')}");
});

test('renders directional arrows as centered icons instead of font glyphs', () => {
  const screen = readFileSync(
    resolve(__dirname, '../src/components/TerminalScreen.tsx'),
    'utf8',
  );

  expect(screen).toContain("up: { icon: ArrowUp, accessibilityKey: 'terminal.upKey' }");
  expect(screen).toContain("left: { icon: ArrowLeft, accessibilityKey: 'terminal.leftKey' }");
  expect(screen).toContain("right: { icon: ArrowRight, accessibilityKey: 'terminal.rightKey' }");
  expect(screen).toContain("down: { icon: ArrowDown, accessibilityKey: 'terminal.downKey' }");
  expect(screen).toContain('<Icon as={icon} size={TERMINAL_ICON_SIZE} className={className} />');
});

test('always renders Paste and Find as accessible icons', () => {
  const screen = readFileSync(
    resolve(__dirname, '../src/components/TerminalScreen.tsx'),
    'utf8',
  );

  expect(screen).toContain('<ClipboardPaste size={TERMINAL_ICON_SIZE} color={appColors.text} />');
  expect(screen).toContain('<Search size={TERMINAL_ICON_SIZE} color={searchOpen ? appColors.primary : appColors.text} />');
  expect(screen).toContain("accessibilityLabel={t('terminal.paste')}");
  expect(screen).toContain("accessibilityLabel={t('terminal.find')}");
  expect(screen).not.toContain("label={t('terminal.paste')}");
  expect(screen).not.toContain("label={t('terminal.find')}");
});

test('sizes icons, symbols, and text labels without constraining them to the same width', () => {
  const screen = readFileSync(
    resolve(__dirname, '../src/components/TerminalScreen.tsx'),
    'utf8',
  );

  expect(screen).toContain("TERMINAL_ICON_CONTROL_CLASS = 'h-9 w-11 items-center justify-center");
  expect(screen).toContain("TERMINAL_TEXT_CONTROL_CLASS = 'h-9 min-w-11 items-center justify-center");
  expect(screen).toContain("const TERMINAL_ICON_BOX_CLASS = 'size-5 items-center justify-center'");
  expect(screen).toContain('const TERMINAL_ICON_SIZE = 18');
  expect(screen).toContain("symbolic ? 'text-[18px] leading-5' : 'text-[12px] leading-4'");
  expect(screen).toContain('allowFontScaling={false}');
  expect(screen).toContain('includeFontPadding: false');
  expect(screen).toContain("textAlignVertical: 'center'");
});
