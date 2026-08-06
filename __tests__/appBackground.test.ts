import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readSource = (path: string) => readFileSync(resolve(__dirname, `../${path}`), 'utf8');

test('renders the app background behind app screens but not terminal mode', () => {
  const app = readSource('App.tsx');
  const background = readSource('src/components/AppBackground.tsx');

  expect(app).toContain('{!immersiveTerminal && (');
  expect(app).toContain('<AppBackground uri={appBackgroundImageUri} dimming={appBackgroundDimming} />');
  expect(background).toContain("source={{ uri }}");
  expect(background).toContain('opacity: dimming / 100');
});
