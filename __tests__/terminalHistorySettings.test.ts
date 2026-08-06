import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readSource = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('terminal history settings', () => {
  it('opens terminal history management from Settings', () => {
    const settings = readSource('src/components/SettingsScreen.tsx');

    expect(settings).toContain("title={t('settings.terminalHistory')}");
    expect(settings).toContain('value={t(\'settings.terminalHistoryCount\'');
    expect(settings).toContain('<TerminalHistoryManager');
  });

  it('supports multi-select, select all, and confirmed bulk deletion', () => {
    const settings = readSource('src/components/SettingsScreen.tsx');

    expect(settings).toContain('const [selected, setSelected] = useState<Set<string>>(new Set())');
    expect(settings).toContain('accessibilityRole="checkbox"');
    expect(settings).toContain('setSelected(allSelected ? new Set() : new Set(entries));');
    expect(settings).toContain("t(allSelected ? 'settings.clearSelection' : 'settings.selectAll')");
    expect(settings).toContain("t('settings.deleteHistoryTitle')");
    expect(settings).toContain('onDelete(selectedEntries);');
    expect(settings).toContain('style={{ fontFamily: terminalFontFamily }}');
    expect(settings).toContain('font-mono text-[14px] leading-5');
  });

  it('copies an entry on long press', () => {
    const settings = readSource('src/components/SettingsScreen.tsx');

    expect(settings).toContain('Clipboard.setString(entry);');
    expect(settings).toContain('onLongPress={hapticPress(() => copyEntry(entry))}');
    expect(settings).toContain("ToastAndroid.show(t('settings.historyEntryCopied')");
    expect(settings).toContain("accessibilityHint={t('settings.copyHistoryEntryHint')}");
  });

  it('loads and saves history from app state for terminal and settings consumers', () => {
    const app = readSource('App.tsx');

    expect(app).toContain('loadTerminalHistory()');
    expect(app).toContain('saveTerminalHistory(terminalHistory)');
    expect(app).toContain('terminalHistory={terminalHistory}');
    expect(app).toContain('onDeleteTerminalHistory={deleteTerminalHistoryEntries}');
    expect(app).toContain('onTerminalHistoryEntry={recordTerminalHistoryEntry}');
  });
});
