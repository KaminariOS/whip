#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const { readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const selector = process.argv[2];
const timeoutSeconds = Number(process.argv[3] || 20);

if (!selector || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 1) {
  process.stderr.write('usage: node scripts/android-ui-target.cjs <text-or-description> [timeout-seconds]\n');
  process.exit(2);
}

const remotePath = '/data/local/tmp/whip-ui-target.xml';
const localPath = join(tmpdir(), `whip-ui-target-${process.pid}.xml`);
const deadline = Date.now() + timeoutSeconds * 1000;

function decodeXml(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function nodeCenter(xml) {
  const descriptionMatches = [];
  for (const match of xml.matchAll(/<node\b[^>]*>/g)) {
    const node = match[0];
    const text = decodeXml(/\btext="([^"]*)"/.exec(node)?.[1] || '');
    const description = decodeXml(/\bcontent-desc="([^"]*)"/.exec(node)?.[1] || '');
    const bounds = /\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
    if (!bounds) continue;
    const [, left, top, right, bottom] = bounds.map(Number);
    const center = `${Math.round((left + right) / 2)} ${Math.round((top + bottom) / 2)}`;
    if (text === selector || description === selector) return center;
    if (description.includes(selector)) {
      descriptionMatches.push({ center, width: right - left, excess: description.length - selector.length });
    }
  }
  descriptionMatches.sort((left, right) => right.width - left.width || left.excess - right.excess);
  return descriptionMatches[0]?.center || null;
}

try {
  while (Date.now() < deadline) {
    try {
      execFileSync('adb', ['shell', 'uiautomator', 'dump', remotePath], { stdio: 'ignore' });
      execFileSync('adb', ['pull', remotePath, localPath], { stdio: 'ignore' });
      const center = nodeCenter(readFileSync(localPath, 'utf8'));
      if (center) {
        process.stdout.write(`${center}\n`);
        process.exit(0);
      }
    } catch {
      // The UI hierarchy can be unavailable for a frame while React navigates.
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  process.stderr.write(`Android UI target not found: ${selector}\n`);
  process.exit(1);
} finally {
  rmSync(localPath, { force: true });
  try {
    execFileSync('adb', ['shell', 'rm', remotePath], { stdio: 'ignore' });
  } catch {
    // Best-effort cleanup only.
  }
}
