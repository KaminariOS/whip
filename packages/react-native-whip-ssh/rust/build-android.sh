#!/usr/bin/env bash
set -euo pipefail

rust_dir="$(cd "$(dirname "$0")" && pwd)"
target="aarch64-linux-android"
source_library="$rust_dir/target/$target/release/libwhip_ssh.a"
destination_library="$rust_dir/../android/src/main/jniLibs/arm64-v8a/libwhip_ssh.a"

cargo build \
  --locked \
  --manifest-path "$rust_dir/Cargo.toml" \
  --target "$target" \
  --release

install -D -m 0644 "$source_library" "$destination_library"
