#!/usr/bin/env bash
set -euo pipefail

action="${1:-}"
fixture_dir="${2:-}"

if [[ -z "$fixture_dir" ]]; then
  echo "usage: $0 <start|stop> <fixture-directory> [github-env]" >&2
  exit 2
fi

metadata="$fixture_dir/fixture.env"

stop_fixture() {
  if [[ ! -f "$metadata" ]]; then return; fi
  # shellcheck disable=SC1090
  source "$metadata"
  if [[ -n "${WHIP_E2E_SSHD_PID:-}" ]]; then
    sudo kill "$WHIP_E2E_SSHD_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${WHIP_E2E_USER:-}" ]] && dscl . -read "/Users/$WHIP_E2E_USER" >/dev/null 2>&1; then
    sudo dscl . -delete "/Users/$WHIP_E2E_USER" >/dev/null
  fi
}

if [[ "$action" == "stop" ]]; then
  stop_fixture
  exit 0
fi
if [[ "$action" != "start" ]]; then
  echo "unknown fixture action: $action" >&2
  exit 2
fi

github_env="${3:-}"
mkdir -p "$fixture_dir"
chmod 0755 "$fixture_dir"
username="whipe2e${RANDOM}"
password="whip-${RANDOM}-${RANDOM}"
uid="$(dscl . -list /Users UniqueID | awk '$2 < 60000 && $2 > maximum { maximum = $2 } END { print maximum + 1 }')"
port="$(ruby -rsocket -e 'server = TCPServer.new("127.0.0.1", 0); puts server.local_address.ip_port; server.close')"
home_dir="$fixture_dir/home"

ssh-keygen -q -t ed25519 -N '' -C whip-ios-e2e-client -f "$fixture_dir/client_key"
ssh-keygen -q -t ed25519 -N '' -C whip-ios-e2e-host -f "$fixture_dir/host_key"
ssh-keygen -q -t ed25519 -N '' -C whip-ios-e2e-changed -f "$fixture_dir/changed_host_key"
cp "$fixture_dir/client_key.pub" "$fixture_dir/authorized_keys"

sudo dscl . -create "/Users/$username"
cat >"$metadata" <<EOF
WHIP_E2E_SSHD_PID=
WHIP_E2E_USER=$username
EOF
trap stop_fixture ERR
sudo dscl . -create "/Users/$username" UserShell /bin/zsh
sudo dscl . -create "/Users/$username" RealName "Whip iOS E2E"
sudo dscl . -create "/Users/$username" UniqueID "$uid"
sudo dscl . -create "/Users/$username" PrimaryGroupID 20
sudo dscl . -create "/Users/$username" NFSHomeDirectory "$home_dir"
sudo dscl . -passwd "/Users/$username" "$password"
mkdir -p "$home_dir"
chmod 0700 "$home_dir"
sudo chown -R "$uid:20" "$home_dir"

cat >"$fixture_dir/sshd_config" <<EOF
Port $port
ListenAddress 127.0.0.1
HostKey $fixture_dir/host_key
PidFile $fixture_dir/sshd.pid
AuthorizedKeysFile $fixture_dir/authorized_keys
StrictModes no
PasswordAuthentication yes
KbdInteractiveAuthentication no
UsePAM yes
PermitRootLogin no
AllowUsers $username
AllowTcpForwarding yes
AllowAgentForwarding yes
Subsystem sftp internal-sftp
LogLevel DEBUG3
EOF

# sshd needs root; the runner intentionally owns its diagnostic log.
# shellcheck disable=SC2024
sudo /usr/sbin/sshd -D -e -f "$fixture_dir/sshd_config" >"$fixture_dir/sshd.log" 2>&1 &
sshd_pid=$!
cat >"$metadata" <<EOF
WHIP_E2E_SSHD_PID=$sshd_pid
WHIP_E2E_USER=$username
EOF

known_host_line=''
for _ in $(seq 1 30); do
  known_host_line="$(ssh-keyscan -T 1 -t ed25519 -p "$port" 127.0.0.1 2>/dev/null | awk '!/^#/ { print; exit }' || true)"
  if [[ -n "$known_host_line" ]]; then break; fi
  sleep 1
done
if [[ -z "$known_host_line" ]]; then
  cat "$fixture_dir/sshd.log" >&2
  echo 'error: macOS OpenSSH fixture did not become ready' >&2
  exit 1
fi

ssh -i "$fixture_dir/client_key" \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -p "$port" \
  "$username@127.0.0.1" \
  "test \"\$(printf whip-fixture-ready)\" = whip-fixture-ready"

changed_key_material="$(awk '{ print $1 " " $2 }' "$fixture_dir/changed_host_key.pub")"
changed_host_line="[127.0.0.1]:$port $changed_key_material"
ruby -rjson -e '
  config = {
    host: "127.0.0.1",
    port: Integer(ARGV[0]),
    username: ARGV[1],
    password: ARGV[2],
    privateKey: File.read(ARGV[3]),
    knownHostLine: ARGV[4],
    changedHostLine: ARGV[5],
  }
  File.write(ARGV[6], JSON.pretty_generate(config))
' "$port" "$username" "$password" "$fixture_dir/client_key" \
  "$known_host_line" "$changed_host_line" "$fixture_dir/whip-ios-ssh-e2e-config.json"

if [[ -n "$github_env" ]]; then
  {
    echo "WHIP_E2E_FIXTURE_DIR=$fixture_dir"
    echo "WHIP_E2E_SSH_PORT=$port"
  } >>"$github_env"
fi
echo "OpenSSH fixture ready on 127.0.0.1:$port for $username"
