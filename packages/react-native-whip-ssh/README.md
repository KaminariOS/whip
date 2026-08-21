# react-native-whip-ssh

Whip's private React Native SSH package owns the complete mobile SSH stack:

- the `SSHClient` JavaScript API used by the app;
- generated UniFFI TypeScript and C++ bindings;
- the Android Kotlin/JNI and iOS Objective-C++ TurboModule installers; and
- the shared `rust/` crate built on Russh and `russh-sftp`.

Both Android and iOS use this Russh transport. There is no JSch, NMSSH, or
platform-specific SSH fallback.

## App API

Import the client and its types from this package:

```ts
import SSHClient, { PtyType, type LsResult } from 'react-native-whip-ssh';
```

The facade preserves the app's established promise, callback, shell-event,
SFTP, forwarding, and Herdr bridge contracts while routing every operation to
the UniFFI module in `src/index.ts`.

## Development

Run the platform-neutral transport checks from the repository root:

```sh
nix develop -c cargo fmt --check \
  --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml
nix develop -c cargo clippy --locked --all-targets \
  --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml -- -D warnings
nix develop -c cargo test --locked \
  --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml
```

Build the Android ARM64 static library with:

```sh
nix develop -c bash packages/react-native-whip-ssh/rust/build-android.sh
```

The repository postinstall and EAS hooks generate the ARM64 iOS framework via
`scripts/build-ios-uniffi.sh` and `ubrn.config.yaml`.

## Provenance

The public `SSHClient` shape originated in the
[`react-native-ssh-sftp`](https://github.com/enatividad/react-native-ssh-sftp)
fork family, including the Dylan Kenneally fork previously vendored under its
package name. Whip now maintains that compatibility facade as part of its own
Russh implementation; none of the upstream native transports are included or
linked.

Whip's package and transport changes are licensed under
`AGPL-3.0-or-later`; see the repository root `LICENSE`.
