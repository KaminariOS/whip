#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const target = `${process.platform}-${process.arch}`;
const supportedTargets = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
]);

if (!supportedTargets.has(target)) {
  console.error(
    `whip-pair does not provide a binary for ${target}. ` +
      "Supported targets: macOS and Linux on ARM64 or x64.",
  );
  process.exit(1);
}

const binary = path.join(__dirname, "..", "vendor", target, "whip-pair");
if (!fs.existsSync(binary)) {
  console.error(
    `The whip-pair package is missing its ${target} binary. ` +
      "Reinstall the package and try again.",
  );
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  console.error(`Unable to start whip-pair: ${result.error.message}`);
  process.exit(1);
}

if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exit(result.status === null ? 1 : result.status);
}
