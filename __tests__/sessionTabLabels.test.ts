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

  it('renders an immediate close control on every space', () => {
    const rail = readFileSync(
      resolve(__dirname, '../src/components/WorkspaceRail.tsx'),
      'utf8',
    );

    expect(rail).toContain("accessibilityLabel={t('rail.closeWorkspace', { workspace: label })}");
    expect(rail).toContain('onPress={hapticPress(onClose)}');
  });

  it('uses the app palette for Herd and Terminal header chrome', () => {
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

    expect(hostRail).toContain('border-b border-border bg-background');
    expect(workspaceRail).toContain('border-b border-border bg-background');
    expect(screen).toContain('h-[42px] flex-row border-b border-border bg-background');
    expect(hostRail).not.toContain('bg-terminal-panel');
    expect(workspaceRail).not.toContain('bg-terminal-panel');
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
    expect(screen).toContain("autoFocus selectTextOnFocus={editorMode === 'rename-tab'}");
  });
});
