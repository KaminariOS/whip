import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(root, 'licenses/cargo/about.toml');
const templatePath = resolve(root, 'licenses/cargo/about.hbs');
const outputDirectory = resolve(root, 'build');

const packages = [
  {
    name: 'react-native-russh',
    manifest: 'packages/react-native-russh/rust/Cargo.toml',
    output: 'cargo-react-native-russh-licenses.html',
  },
  {
    name: 'whip-ssh',
    manifest: 'packages/react-native-whip-ssh/rust/Cargo.toml',
    output: 'cargo-whip-ssh-licenses.html',
  },
];

await mkdir(outputDirectory, { recursive: true });

for (const rustPackage of packages) {
  const outputPath = resolve(outputDirectory, rustPackage.output);
  try {
    await execFileAsync(
      'cargo',
      [
        'about',
        'generate',
        '--locked',
        '--fail',
        '--config',
        configPath,
        '--manifest-path',
        resolve(root, rustPackage.manifest),
        '--output-file',
        outputPath,
        templatePath,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
      },
    );
  } catch (error) {
    const details = error.stderr?.trim() || error.stdout?.trim() || error.message;
    throw new Error(`cargo-about failed for ${rustPackage.name}: ${details}`);
  }

  const notice = await readFile(outputPath, 'utf8');
  if (!notice.includes('<!doctype html>') || !notice.includes('<section id=')) {
    throw new Error(`cargo-about produced an incomplete notice for ${rustPackage.name}`);
  }

  console.log(`Checked ${rustPackage.name}; wrote ${relativePath(outputPath)}.`);
}

function relativePath(path) {
  return path.slice(root.length + 1);
}
