#!/usr/bin/env bash
set -euo pipefail

test_root="$(mktemp -d)"
sshd_pid=""
pair_pid=""

cleanup() {
  if [[ -n "$pair_pid" ]]; then kill "$pair_pid" 2>/dev/null || true; fi
  if [[ -n "$sshd_pid" ]]; then kill "$sshd_pid" 2>/dev/null || true; fi
  rm -rf -- "$test_root"
}
trap cleanup EXIT

for _ in {1..50}; do
  ssh_port=$((20000 + RANDOM % 20000))
  if ! ss -Hln "sport = :$ssh_port" | rg -q .; then break; fi
done
if ss -Hln "sport = :$ssh_port" | rg -q .; then
  echo "could not find a free test port" >&2
  exit 1
fi

ssh-keygen -q -t ed25519 -N '' -f "$test_root/host_key"
ssh-keygen -q -t ed25519 -N '' -f "$test_root/permanent_key"
install -m 600 /dev/null "$test_root/authorized_keys"
printf '%s\n' \
  "Port $ssh_port" \
  "ListenAddress 127.0.0.1" \
  "HostKey $test_root/host_key" \
  "AuthorizedKeysFile $test_root/authorized_keys" \
  "PidFile $test_root/sshd.pid" \
  "AllowUsers $USER" \
  "StrictModes no" \
  "UsePAM no" \
  "PasswordAuthentication no" \
  "KbdInteractiveAuthentication no" \
  "PubkeyAuthentication yes" \
  "LogLevel ERROR" >"$test_root/sshd_config"

"$(command -v sshd)" -D -e -f "$test_root/sshd_config" >"$test_root/sshd.log" 2>&1 &
sshd_pid=$!
for _ in {1..50}; do
  if ssh-keyscan -T 1 -p "$ssh_port" 127.0.0.1 >/dev/null 2>&1; then break; fi
  sleep 0.1
done
if ! kill -0 "$sshd_pid" 2>/dev/null; then
  sed -n '1,80p' "$test_root/sshd.log" >&2
  exit 1
fi

cargo build --quiet --manifest-path whip-pair/Cargo.toml
pair_binary="whip-pair/target/debug/whip-pair"
"$pair_binary" serve \
  --bind 127.0.0.1 \
  --ssh-port "$ssh_port" \
  --authorized-keys "$test_root/authorized_keys" \
  --ttl 30 \
  --yes \
  --code-output "$test_root/code" >"$test_root/pair.log" 2>&1 &
pair_pid=$!
for _ in {1..50}; do
  if [[ -s "$test_root/code" ]]; then break; fi
  if ! kill -0 "$pair_pid" 2>/dev/null; then
    sed -n '1,120p' "$test_root/pair.log" >&2
    exit 1
  fi
  sleep 0.1
done

IFS= read -r pairing_code <"$test_root/code"
"$pair_binary" request \
  --code "$pairing_code" \
  --public-key "$test_root/permanent_key.pub" \
  --device-name "WP4 end-to-end test"
wait "$pair_pid"
pair_pid=""

if rg -q 'whip-pair-temporary' "$test_root/authorized_keys"; then
  echo "temporary authorization was not removed" >&2
  exit 1
fi
permanent_fingerprint="$(ssh-keygen -lf "$test_root/permanent_key.pub" | awk '{print $2}')"
authorized_fingerprint="$(ssh-keygen -lf "$test_root/authorized_keys" | awk '{print $2}')"
if [[ "$permanent_fingerprint" != "$authorized_fingerprint" ]]; then
  echo "the permanent key was not enrolled" >&2
  exit 1
fi

echo "WP4 SSH-only pairing passed"
