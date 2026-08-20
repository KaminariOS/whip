#!/usr/bin/env bash
set -euo pipefail

rust_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$rust_dir/../../.." && pwd)"
target="aarch64-linux-android"
source_library="$rust_dir/target/$target/release/libwhip_ssh.a"
destination_library="$repo_root/packages/react-native-whip-ssh/android/src/main/jniLibs/arm64-v8a/libwhip_ssh.a"

cargo build \
  --locked \
  --manifest-path "$rust_dir/Cargo.toml" \
  --target "$target" \
  --release

install -D -m 0644 "$source_library" "$destination_library"
