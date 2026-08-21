#!/usr/bin/env bash
set -euo pipefail

rust_dir="$(cd "$(dirname "$0")" && pwd)"
target="aarch64-linux-android"
source_library="$rust_dir/target/$target/release/libreact_native_russh.a"
destination_library="$rust_dir/../android/src/main/jniLibs/arm64-v8a/libreact_native_russh.a"

cargo build \
  --locked \
  --manifest-path "$rust_dir/Cargo.toml" \
  --target "$target" \
  --release

install -D -m 0644 "$source_library" "$destination_library"
