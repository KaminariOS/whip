import {rename} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const raw = resolve(here, '../../output/whip-launch-hyperframes.raw.mp4');
const normalized = resolve(here, '../../output/whip-launch-hyperframes.normalized.mp4');
const output = resolve(here, '../../output/whip-launch-hyperframes.mp4');

const result = spawnSync('ffmpeg', [
  '-y',
  '-i', raw,
  '-map', '0:v:0',
  '-map', '0:a:0',
  '-c:v', 'copy',
  // Leave extra sample-peak headroom for AAC inter-sample overshoot.
  '-af', 'loudnorm=I=-15:TP=-1.5:LRA=7,alimiter=limit=0.72:level=false',
  '-c:a', 'aac',
  '-b:a', '256k',
  '-ar', '48000',
  '-movflags', '+faststart',
  normalized,
], {stdio: 'inherit'});

if (result.status !== 0) process.exit(result.status ?? 1);
await rename(normalized, output);
console.log(`Normalized production master: ${output}`);
