import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('session tab labels', () => {
  it('removes inherited vertical padding from compact host labels', () => {
    const rail = readFileSync(
      resolve(__dirname, '../src/components/LiveSessionRail.tsx'),
      'utf8',
    );

    expect(rail).toContain(
      'h-8 min-w-0 flex-shrink justify-start gap-1.5 rounded-none px-2.5 py-0',
    );
    expect(rail).toContain(
      'max-w-[119px] pb-0.5 text-[11px] font-semibold leading-[18px]',
    );
  });

  it('removes inherited vertical padding from compact space labels', () => {
    const rail = readFileSync(
      resolve(__dirname, '../src/components/WorkspaceRail.tsx'),
      'utf8',
    );

    expect(rail).toContain(
      'h-8 min-w-0 flex-shrink justify-start gap-1.5 rounded-none px-2.5 py-0',
    );
    expect(rail).toContain(
      'max-w-[104px] pb-0.5 text-[11px] font-semibold leading-[18px]',
    );
  });

  it('uses compiled theme classes for selected host and space labels', () => {
    const hostRail = readFileSync(
      resolve(__dirname, '../src/components/LiveSessionRail.tsx'),
      'utf8',
    );
    const workspaceRail = readFileSync(
      resolve(__dirname, '../src/components/WorkspaceRail.tsx'),
      'utf8',
    );

    for (const rail of [hostRail, workspaceRail]) {
      expect(rail).toContain("? 'text-primary'");
      expect(rail).toContain(": 'text-primary-foreground'");
      expect(rail.match(/activeTextClass\)}/g)).toHaveLength(2);
    }
  });

  it('uses a server icon for the aggregate host pill', () => {
    const rail = readFileSync(
      resolve(__dirname, '../src/components/LiveSessionRail.tsx'),
      'utf8',
    );

    expect(rail).toContain("import { Plus, Server, X } from 'lucide-react-native'");
    expect(rail).toContain('<Server size={15}');
  });

  it('uses a layers icon for the aggregate space pill', () => {
    const rail = readFileSync(
      resolve(__dirname, '../src/components/WorkspaceRail.tsx'),
      'utf8',
    );

    expect(rail).toContain("import { Layers3, Plus, X } from 'lucide-react-native'");
    expect(rail).toContain('<Layers3 size={15}');
    expect(rail).toContain('aggregate\n          busy={busy}');
  });

  it('outlines non-focused host and space pills without glass', () => {
    const hostRail = readFileSync(
      resolve(__dirname, '../src/components/LiveSessionRail.tsx'),
      'utf8',
    );
    const workspaceRail = readFileSync(
      resolve(__dirname, '../src/components/WorkspaceRail.tsx'),
      'utf8',
    );

    for (const rail of [hostRail, workspaceRail]) {
      expect(rail).toContain(
        "!appGlassEnabled && !active && 'border border-border'",
      );
    }
  });

  it('avoids clipping selected foreground content on Android', () => {
    const hostRail = readFileSync(
      resolve(__dirname, '../src/components/LiveSessionRail.tsx'),
      'utf8',
    );
    const workspaceRail = readFileSync(
      resolve(__dirname, '../src/components/WorkspaceRail.tsx'),
      'utf8',
    );

    for (const rail of [hostRail, workspaceRail]) {
      expect(
        rail.match(/!appGlassEnabled && active && 'bg-primary'/g),
      ).toHaveLength(1);
      expect(rail).not.toContain(
        'max-w-[190px] flex-row items-center overflow-hidden rounded-full',
      );
    }
  });

  it('renders an immediate close control on every space', () => {
    const rail = readFileSync(
      resolve(__dirname, '../src/components/WorkspaceRail.tsx'),
      'utf8',
    );

    expect(rail).toContain("accessibilityLabel={t('rail.closeWorkspace', { workspace: label })}");
    expect(rail).toContain('onPress={hapticPress(onClose)}');
  });

  it('keeps terminal header chrome transparent over its shared background', () => {
    const hostRail = readFileSync(
      resolve(__dirname, '../src/components/LiveSessionRail.tsx'),
      'utf8',
    );
    const workspaceRail = readFileSync(
      resolve(__dirname, '../src/components/WorkspaceRail.tsx'),
      'utf8',
    );
    const screen = readFileSync(
      resolve(__dirname, '../src/components/SessionScreen.tsx'),
      'utf8',
    );

    expect(hostRail).toContain('<GlassSurface className="h-12');
    expect(workspaceRail).toContain('<GlassSurface className="h-12');
    expect(screen).toContain('<TerminalBackground preferences={terminalPreferences} />');
    expect(screen).toContain('className="absolute inset-x-0 top-0 z-30"');
    expect(screen).toContain('h-[42px] flex-row border-b border-border bg-transparent');
    expect(screen).toContain('h-[37px] flex-row border-b border-border bg-transparent');
    expect(hostRail).not.toContain('bg-terminal-panel');
    expect(workspaceRail).not.toContain('bg-terminal-panel');
  });

  it('uses translucent glass styling for terminal tabs and panes', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/SessionScreen.tsx'),
      'utf8',
    );

    expect(screen.match(/style=\{sessionTabGlassStyle\(active, colors\)\}/g)).toHaveLength(2);
    expect(screen.match(/overflow-hidden rounded-full border/g)).toHaveLength(2);
    expect(screen).not.toContain("rounded-full bg-muted', active && 'bg-primary'");
  });

  it('leaves enough vertical space for Android font descenders', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/SessionScreen.tsx'),
      'utf8',
    );

    expect(screen).toContain(
      'h-[30px] min-w-0 flex-shrink justify-start gap-2 rounded-none px-[11px] py-0 pr-1',
    );
    expect(screen).toContain(
      'max-w-[94px] pb-0.5 text-[11px] font-semibold leading-[18px]',
    );
  });

  it('renders an immediate close control on every tab', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/SessionScreen.tsx'),
      'utf8',
    );

    expect(screen).toContain("accessibilityLabel={t('session.closeTab', { tab: label })}");
    expect(screen).toContain('onPress={hapticPress(() => closeTab(item))}');
  });

  it('opens a focused rename field when any tab is long-pressed', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/SessionScreen.tsx'),
      'utf8',
    );

    expect(screen).toContain('onLongPress={hapticPress(() => openRenameTab(item))}');
    expect(screen).toContain('if (item.tab_id !== selectedTab?.tab_id) chooseTab(item);');
    expect(screen).toContain("autoFocus selectTextOnFocus={editorMode.startsWith('rename')}");
  });

  it('uses direct, vertically centered controls for every pane', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/SessionScreen.tsx'),
      'utf8',
    );

    expect(screen).not.toContain("accessibilityLabel={t('session.actions')}");
    expect(screen).toContain("accessibilityLabel={t('session.closePane', { pane: label })}");
    expect(screen).toContain('onLongPress={hapticPress(() => openRenamePane(pane))}');
    expect(screen).toContain('max-w-[112px] pb-0.5 text-[11px] font-semibold leading-[18px]');
    expect(screen).toContain('h-7 min-w-0 flex-shrink justify-start gap-1.5 rounded-none px-2 py-0');
  });
});
