import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('LogBox warning filters', () => {
  it('loads the narrow SafeAreaView filter before the app module', () => {
    const entry = readFileSync(resolve(__dirname, '../index.js'), 'utf8');
    const warnings = readFileSync(resolve(__dirname, '../src/logBoxWarnings.ts'), 'utf8');

    expect(entry.indexOf("import './src/logBoxWarnings';"))
      .toBeLessThan(entry.indexOf("import App from './App';"));
    expect(warnings).toContain('if (__DEV__)');
    expect(warnings).toContain('LogBox.ignoreLogs([');
    expect(warnings).toContain('SafeAreaView has been deprecated and will be removed in a future release.');
  });
});
