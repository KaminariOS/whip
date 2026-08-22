# react-native-russh

React Native SSH and SFTP for the New Architecture, powered by
[`russh`](https://github.com/Eugeny/russh).

The package exposes a generic SSH and SFTP API for React Native applications.

<p align="center">
  <a href="docs/architecture.svg"><img src="docs/architecture.svg" alt="react-native-russh architecture" width="280"></a>
</p>

[Edit the architecture diagram](docs/architecture.mmd), then regenerate the
SVG from the repository root with `nix develop -c npm run generate:readme-diagrams`.

## Requirements

- React Native 0.76 or newer with the New Architecture enabled
- Android 7.0 / API 24 or newer on ARM64 (`arm64-v8a`)
- iOS 16.4 or newer on ARM64 devices and Apple Silicon simulators

Intel Android emulators and Intel iOS simulators are not included in the
initial release.

## Install

```sh
npm install react-native-russh
```

For iOS, install pods after npm finishes:

```sh
cd ios && pod install
```

## Quick start

`react-native-russh` verifies host keys strictly. Load an OpenSSH
`known_hosts` entry before connecting; an unknown or changed key rejects the
connection with a structured `SshError`.

```ts
import SSHClient from 'react-native-russh';

SSHClient.setKnownHosts(
  'server.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...',
);

const ssh = await SSHClient.connectWithKey(
  'server.example',
  22,
  'alice',
  privateKey,
);

const output = await ssh.execute('uname -a');
const files = await ssh.sftpLs('/var/log');
ssh.disconnect();
```

## Errors

Native failures are JavaScript `Error` objects with stable `code`, `message`,
and optional `details` fields. UI text should be selected from `code`; `message`
is intended for logs and diagnostics.

Host-key failures use `HOST_KEY_UNKNOWN` or `HOST_KEY_CHANGED`. Their `details`
contain `host`, `port`, `keyType`, `fingerprint`, and `publicKey`, so consumers
never need to parse a Russh message or a JSON suffix. Other transport codes
include `AUTHENTICATION_FAILED`, `CONNECTION_REFUSED`, `CONNECTION_TIMEOUT`,
`HOST_UNREACHABLE`, `CHANNEL_UNAVAILABLE`, `SESSION_CLOSED`,
`INVALID_PRIVATE_KEY`, and `SFTP_FAILURE`.

## Remote Unix sockets

OpenSSH `direct-streamlocal@openssh.com` channels provide byte-stream access to
Unix-domain sockets on the SSH host. Channels are independently identified, so
one SSH connection can carry several concurrent protocols.

```ts
const channel = await ssh.openUnixSocketChannel('/run/example.sock', event => {
  if (event.type === 'data') {
    consumeBytes(new Uint8Array(event.bytes));
  } else {
    console.log(`channel closed: ${event.reason}`);
  }
});

await channel.write(new TextEncoder().encode('hello\n').buffer);
await channel.close();

const response = await ssh.requestUnixSocket(
  '/run/example.sock',
  '{"operation":"status"}\n',
);

const framed = await ssh.openLengthPrefixedUnixSocketChannel(
  '/run/binary-protocol.sock',
  { lengthFormat: 'u32le', maxFrameBytes: 4 * 1024 * 1024 },
  event => {
    if (event.type === 'data') consumeCompleteFrame(event.bytes);
  },
);
await framed.write(binaryPayload);
```

The framed reader retains partial prefix/payload progress across cancellation,
allocates each complete payload once, and transfers that owned payload through
the typed callback.

The SSH server must permit Unix-socket forwarding and the authenticated user
must be able to access the requested socket path.

## Persistent exec channels

Use `openExecChannel` when a remote command stays alive and exchanges binary or
streaming data over stdin/stdout:

```ts
const process = await ssh.openExecChannel('my-long-running-command', event => {
  if (event.type === 'data') consumeOutput(event.bytes);
});
await process.write(new TextEncoder().encode('input\n').buffer);
await process.close();
```

## Public capabilities

- OpenSSH `known_hosts` verification, including hashed hostnames
- Ed25519, RSA, and ECDSA private-key authentication supported by Russh
- Password authentication and jump hosts
- Key generation and key inspection
- Command execution and interactive PTY shells
- SSH agent forwarding for private-key sessions
- Local TCP forwarding and host-latency measurement
- Concurrent OpenSSH Unix-socket channels with raw or length-prefixed
  `ArrayBuffer` I/O (`u8`, `u16`, or `u32`, big- or little-endian)
- Persistent exec channels with binary stdin/stdout
- SFTP listing, mutation, recursive directory creation, directory or exact-path
  transactional upload, download, cancellation, and ranged serving

Only generic SSH and SFTP capabilities are exported from the package root.

## Development

From the repository root:

```sh
nix develop -c cargo fmt --check \
  --manifest-path packages/react-native-russh/rust/Cargo.toml
nix develop -c cargo clippy --locked --all-targets \
  --manifest-path packages/react-native-russh/rust/Cargo.toml -- -D warnings
nix develop -c cargo test --locked \
  --manifest-path packages/react-native-russh/rust/Cargo.toml
nix develop -c bash packages/react-native-russh/rust/build-android.sh
```

## License and provenance

The Rust/Russh transport and React Native integration are licensed under
`AGPL-3.0-or-later`. The compatibility shape of `SSHClient` descends from the
MIT-licensed `react-native-ssh-sftp` fork family; see
[`PROVENANCE.md`](PROVENANCE.md).
