#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${EAS_BUILD_PLATFORM:-}" && "${EAS_BUILD_PLATFORM}" != "ios" ]]; then
  exit 0
fi

if [[ -z "${EAS_BUILD_PLATFORM:-}" && "${WHIP_BUILD_IOS_UNIFFI:-}" != "1" && "$(uname -s)" != "Darwin" ]]; then
  exit 0
fi

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
module_dir="$root_dir/packages/react-native-whip-ssh"
export PATH="$root_dir/node_modules/.bin:$HOME/.cargo/bin:$PATH"
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-16.4}"

if ! command -v ubrn >/dev/null 2>&1; then
  echo "error: ubrn is unavailable; install dependencies before generating the iOS bridge" >&2
  exit 1
fi

(
  cd "$module_dir"
  ubrn build ios \
    --config ubrn.config.yaml \
    --release \
    --and-generate \
    --no-sim
)
