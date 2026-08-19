# Whip Rust SSH transport

This crate is the Rust/Russh transport behind the existing `SSHClient`
JavaScript API on iOS and Android. Both platforms use the UniFFI React Native
module; the Rust/Russh implementation is the only native SSH transport.

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
- Herdr direct stream-local API requests, event streams, and command streams
- retained Herdr terminal bridges using the protocol 17–20 binary framing

The mobile backend intentionally rejects RSA private keys for now. Russh's current
RSA path depends on a crate affected by RUSTSEC-2023-0071 with no patched
release. Ed25519 keys are supported and tested; this restriction does not alter
the legacy Android key support.

Agent forwarding exposes only the identity used for key authentication and
rejects remote agent mutation requests. Password-authenticated sessions do not
have an identity to forward.

The JavaScript wrapper does not fall back to an NMSSH session with different
trust behavior.

## Checks without a Mac

Run the platform-neutral tests on Linux:

```sh
nix develop -c nix shell nixpkgs#cargo nixpkgs#rustc -c \
  cargo test --manifest-path packages/react-native-ssh-sftp/rust/Cargo.toml
```

Run the live OpenSSH feature matrix with Podman (or Docker):

```sh
nix develop -c nix shell nixpkgs#cargo nixpkgs#rustc nixpkgs#openssh -c \
  bash packages/react-native-ssh-sftp/rust/tests/live-ssh.sh
```

Run an unsigned iOS simulator build on EAS (no paid Apple membership needed):

```sh
npx eas-cli build --platform ios --profile ios-simulator
```

The CocoaPods build phase compiles Rust for the active iOS SDK and architecture.
The EAS pre-install hook installs the stable Rust toolchain and Apple targets.
