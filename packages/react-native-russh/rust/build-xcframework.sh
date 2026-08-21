#!/usr/bin/env bash
set -euo pipefail

rust_dir="$(cd "$(dirname "$0")" && pwd)"
destination="${1:-$rust_dir/../build/ReactNativeRussh.xcframework}"

export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$rust_dir/target"

if [[ -e "$destination" ]]; then
  echo "error: XCFramework destination already exists: $destination" >&2
  exit 1
fi

targets=(aarch64-apple-ios aarch64-apple-ios-sim)
for target in "${targets[@]}"; do
  if ! rustup target list --installed --toolchain 1.97.1 | grep -Fxq "$target"; then
    echo "error: missing Rust target $target for toolchain 1.97.1" >&2
    exit 1
  fi
  (
    cd "$rust_dir"
    cargo build --release --locked --target "$target"
  )
done

mkdir -p "$(dirname "$destination")"
xcodebuild -create-xcframework \
  -library "$CARGO_TARGET_DIR/aarch64-apple-ios/release/libreact_native_russh.a" \
  -headers "$rust_dir/include" \
  -library "$CARGO_TARGET_DIR/aarch64-apple-ios-sim/release/libreact_native_russh.a" \
  -headers "$rust_dir/include" \
  -output "$destination"
