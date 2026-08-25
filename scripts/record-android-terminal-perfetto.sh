#!/usr/bin/env bash
set -euo pipefail

target_tab="${1:-}"
comparison_tab="${2:-}"
duration_seconds="${3:-20}"
output_path="${4:-artifacts/perfetto/ci-terminal-input.perfetto-trace}"
rotate="${5:-true}"

if [[ -z "$target_tab" || -z "$comparison_tab" ]]; then
  echo "usage: $0 <cold-target-tab-label> <comparison-tab-label> [duration] [output] [rotate]" >&2
  exit 2
fi
if [[ ! "$duration_seconds" =~ ^[1-9][0-9]*$ ]] || (( duration_seconds < 12 || duration_seconds > 60 )); then
  echo "Duration must be an integer from 12 to 60 seconds." >&2
  exit 2
fi
if [[ "$rotate" != true && "$rotate" != false ]]; then
  echo "Rotate must be true or false." >&2
  exit 2
fi

device_count="$(adb devices | awk 'NR > 1 && $2 == "device" { count += 1 } END { print count + 0 }')"
if [[ "$device_count" != 1 ]]; then
  echo "Expected exactly one authorized Android device; found $device_count." >&2
  adb devices -l >&2
  exit 1
fi

original_accelerometer_rotation="$(adb shell settings get system accelerometer_rotation | tr -d '\r')"
original_user_rotation="$(adb shell settings get system user_rotation | tr -d '\r')"
capture_pid=''

restore_device() {
  if [[ "$rotate" == true ]]; then
    adb shell settings put system accelerometer_rotation "$original_accelerometer_rotation" >/dev/null 2>&1 || true
    adb shell settings put system user_rotation "$original_user_rotation" >/dev/null 2>&1 || true
  fi
  if [[ -n "$capture_pid" ]]; then
    wait "$capture_pid" || true
  fi
}
trap restore_device EXIT

if [[ "$rotate" == true ]]; then
  adb shell settings put system accelerometer_rotation 0
  adb shell settings put system user_rotation 0
  sleep 1
fi

read -r target_x target_y < <(node scripts/android-ui-target.cjs "$target_tab")
read -r comparison_x comparison_y < <(node scripts/android-ui-target.cjs "$comparison_tab")

screen_size="$(adb shell wm size | awk -F': ' '/size:/{ value=$2 } END { print value }' | tr -d '\r')"
if [[ ! "$screen_size" =~ ^([0-9]+)x([0-9]+)$ ]]; then
  echo "Unable to determine Android screen size: $screen_size" >&2
  exit 1
fi
screen_width="${BASH_REMATCH[1]}"
screen_height="${BASH_REMATCH[2]}"
terminal_x="$((screen_width / 2))"
terminal_y="$((screen_height * 58 / 100))"

scripts/capture-android-perfetto.sh "$duration_seconds" "$output_path" &
capture_pid="$!"
sleep 2

# Keep selection, focus, and input in one device-side command so the first key
# can reach TerminalRendererHost while the cold bridge is still attaching.
adb shell "input tap $target_x $target_y; sleep 0.02; input tap $terminal_x $terminal_y; input text aaaaa"
if [[ "$rotate" == true ]]; then
  sleep 0.25
  adb shell settings put system user_rotation 1
fi

sleep 2
if [[ "$rotate" == true ]]; then
  adb shell settings put system user_rotation 0
  sleep 1
fi
adb shell "input tap $comparison_x $comparison_y; sleep 0.4; input tap $target_x $target_y; sleep 0.02; input tap $terminal_x $terminal_y; input text bbbbb"
if [[ "$rotate" == true ]]; then
  sleep 0.25
  adb shell settings put system user_rotation 1
fi

wait "$capture_pid"
capture_pid=''
