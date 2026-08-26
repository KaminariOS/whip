import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');

describe('bundled direct dependency license notices', () => {
  const generatedRegistry = read('src/licenses/generated.ts');
  const generatedEntries = [...generatedRegistry.matchAll(/[ ]{2}\{\n([\s\S]*?)\n[ ]{2}\},/g)]
    .map(match => Object.fromEntries(
      [...match[1].matchAll(/^[ ]{4}(\w+): "([^"]*)",?$/gm)]
        .map(field => [field[1], field[2]]),
    ));

  test('contains one row for every direct npm production dependency and nothing else', () => {
    const packageJson = JSON.parse(read('package.json'));
    const noticedPackages = generatedEntries
      .filter(entry => entry.category === 'npm')
      .map(entry => entry.projectName)
      .sort();

    expect(noticedPackages).toEqual(Object.keys(packageJson.dependencies).sort());
  });

  test('contains one row per resolved direct Rust crate and excludes workspace roots', () => {
    const expectedPackages = [
      ...directCargoDependencies('packages/react-native-russh/rust/Cargo.toml'),
      ...directCargoDependencies('packages/react-native-whip-ssh/rust/Cargo.toml'),
    ];
    const noticedPackages = generatedEntries
      .filter(entry => entry.category === 'cargo')
      .map(entry => entry.projectName);

    expect([...new Set(noticedPackages)].sort()).toEqual([...new Set(expectedPackages)].sort());
    expect(noticedPackages).not.toContain('react-native-russh');
    expect(noticedPackages).not.toContain('whip-ssh');
  });

  test('every row points to a non-empty deduplicated license asset', () => {
    const assets = [...generatedRegistry.matchAll(/require\("\.\.\/\.\.\/(assets\/licenses\/generated\/[^"]+)"\)/g)]
      .map(match => match[1]);

    expect(assets).toHaveLength(generatedEntries.length);
    for (const asset of new Set(assets)) expect(read(asset).trim()).not.toBe('');
  });
});

function directCargoDependencies(manifestPath: string) {
  return [...read(manifestPath).matchAll(
    /\[(?:dependencies|target\..+\.dependencies)\]\n([\s\S]*?)(?=\n\[|$)/g,
  )].flatMap(section => (
    [...section[1].matchAll(/^([\w-]+)\s*=/gm)].map(match => match[1])
  ));
}

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8');
}
