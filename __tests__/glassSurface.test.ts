import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readSource = (path: string) => readFileSync(resolve(__dirname, `../${path}`), 'utf8');

test('gates app glass across bars and rows behind its experiment and background image', () => {
  const app = readSource('App.tsx');
  const glass = readSource('src/components/GlassSurface.tsx');
  const settings = readSource('src/components/SettingsScreen.tsx');
  const hosts = readSource('src/components/HostsScreen.tsx');
  const herd = readSource('src/components/HerdScreen.tsx');

  expect(app).toContain('enabled={appGlassEnabled && Boolean(appBackgroundImageUri)}');
  expect(glass).toContain('glass?.enabled === true');
  expect(glass).toContain('backgroundColor: colors.surface');
  expect(glass).toContain('blurMethod="dimezisBlurViewSdk31Plus"');
  expect(glass).toContain("Platform.OS !== 'android'");
  expect(glass).toContain('blurTarget={glass.blurTarget}');
  expect(glass).toContain("'rgba(20,22,34,0.38)' : 'rgba(255,255,255,0.42)'");
  expect(settings.match(/<GlassSurface/g)?.length).toBeGreaterThanOrEqual(8);
  expect(hosts).toContain('<GlassSurface className="min-h-[88px]');
  expect(herd).toContain('<GlassBackdrop />');
});
