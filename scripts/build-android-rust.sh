#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"

bash "$root_dir/packages/react-native-whip-ssh/rust/build-android.sh"
