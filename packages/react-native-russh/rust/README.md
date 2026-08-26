# react-native-russh transport

This crate is the Rust/Russh transport behind the public `react-native-russh`
client. Android and iOS use the same UniFFI React Native module.

## Current mobile backend

Implemented:

- strict OpenSSH `known_hosts` verification, including unknown/changed-key challenges
- Ed25519 key generation and OpenSSH private-key inspection
- password and in-memory OpenSSH private-key authentication
- command execution
- interactive PTY input, output, resize, and close
- latency measurement and remote home discovery
- session disconnect
- SFTP listing, mutation, upload/download, progress, and cancellation
- ProxyJump-style chained SSH connections
- restricted agent forwarding for the key-authenticated identity
- loopback TCP forwarding through SSH direct-tcpip channels
- concurrent OpenSSH direct-streamlocal channels with raw byte input/output
- length-prefixed direct-streamlocal channels for binary protocols
- product-neutral native length-prefixed channel callbacks for native protocol
  adapters that must avoid a JavaScript frame round trip
- persistent exec channels with binary stdin/stdout
- bounded delimiter-based requests over remote Unix-domain sockets

The package generates and tests Ed25519 keys by default. Imported OpenSSH private keys
are decoded by the shared Russh backend on both platforms, including ECDSA and
RSA keys supported by the negotiated server algorithms. Prefer Ed25519 for new
profiles because it is the project's cross-platform test baseline.

Agent forwarding exposes only the identity used for key authentication and
rejects remote agent mutation requests. Password-authenticated sessions do not
have an identity to forward.

The JavaScript wrapper does not fall back to an NMSSH session with different
trust behavior.

## Checks without a Mac

Run the platform-neutral tests on Linux:

```sh
nix develop -c nix shell nixpkgs#cargo nixpkgs#rustc -c \
  cargo test --manifest-path packages/react-native-russh/rust/Cargo.toml
```

Run the live OpenSSH feature matrix with Podman (or Docker):

```sh
nix develop -c nix shell nixpkgs#cargo nixpkgs#rustc nixpkgs#openssh -c \
  bash packages/react-native-russh/rust/tests/live-ssh.sh
```

Run an unsigned iOS simulator build on EAS (no paid Apple membership needed):

```sh
npx eas-cli build --platform ios --profile ios-simulator
```

The CocoaPods build phase compiles Rust for the active iOS SDK and architecture.
The EAS pre-install hook installs the stable Rust toolchain and Apple targets.
