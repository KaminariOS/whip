import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readSource = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('resource editor sheets', () => {
  it('uses the app sheet hierarchy for space and terminal tab editors', () => {
    const sheet = readSource('src/components/ResourceEditorSheet.tsx');
    const herd = readSource('src/components/HerdScreen.tsx');
    const session = readSource('src/components/SessionScreen.tsx');

    expect(sheet).toContain('className="flex-1 justify-center px-4"');
    expect(sheet).toContain("behavior={Platform.OS === 'ios' ? 'padding' : 'height'}");
    expect(sheet).toContain('rounded-[28px]');
    expect(sheet).toContain('text-[19px] font-bold');
    expect(sheet).toContain('h-12 flex-1 rounded-full');
    expect(sheet).toContain('<KeyboardAvoidingView');
    expect(herd).toContain('<ResourceEditorSheet');
    expect(session).toContain('<ResourceEditorSheet');
    expect(herd).not.toContain('h-[34px] min-w-[110px] flex-1 rounded-none');
    expect(session).not.toContain('h-[34px] min-w-[110px] flex-1 rounded-none');
  });

  it('keeps space-specific fields and terminal rename selection behavior', () => {
    const herd = readSource('src/components/HerdScreen.tsx');
    const session = readSource('src/components/SessionScreen.tsx');

    expect(herd).toContain("label={t('herd.workingDirectoryOptional')}");
    expect(herd).toContain('workspaceCwdInputRef.current?.focus()');
    expect(session).toContain("selectTextOnFocus={editorMode?.startsWith('rename')}");
    expect(session).toContain("title={editorTitle}");
  });
});
