#!/usr/bin/env bash
set -euo pipefail

rust_dir="$(cd "$(dirname "$0")" && pwd)"
build_dir="$rust_dir/build/${PLATFORM_NAME:-iphoneos}/${CONFIGURATION:-Debug}"
mkdir -p "$build_dir"
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$rust_dir/target"

if ! command -v rustup >/dev/null 2>&1; then
  echo "error: rustup is required to build the iOS SSH transport" >&2
  exit 1
fi

sdk_name="${PLATFORM_NAME:-iphoneos}"
architectures="${ARCHS:-arm64}"
libraries=()

for architecture in $architectures; do
  case "$sdk_name/$architecture" in
    iphoneos/arm64) target="aarch64-apple-ios" ;;
    iphonesimulator/arm64) target="aarch64-apple-ios-sim" ;;
    *)
      echo "error: unsupported iOS Rust target $sdk_name/$architecture" >&2
      exit 1
      ;;
  esac
  if ! rustup target list --installed --toolchain 1.97.1 | grep -Fxq "$target"; then
    echo "error: missing Rust target $target for toolchain 1.97.1" >&2
    echo "Install it once with: rustup target add --toolchain 1.97.1 $target" >&2
    exit 1
  fi
  (
    cd "$rust_dir"
    cargo build --release --locked --target "$target"
  )
  libraries+=("$rust_dir/target/$target/release/libreact_native_russh.a")
done

if [[ ${#libraries[@]} -eq 1 ]]; then
  cp "${libraries[0]}" "$build_dir/libreact_native_russh.a"
else
  xcrun lipo -create "${libraries[@]}" -output "$build_dir/libreact_native_russh.a"
fi
