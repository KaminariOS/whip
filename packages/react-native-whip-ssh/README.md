# react-native-whip-ssh

Private Whip-owned adapter over [`react-native-russh`](../react-native-russh).
It exposes WP4 QR pairing and Herdr bridge/stream behavior while keeping those
product protocols out of the public transport API.

The adapter subclasses the public `SSHClient`. Direct Herdr API requests and
the long-lived event feed use raw OpenSSH Unix-socket channels. The private Rust
crate owns the Herdr terminal codec, Welcome/Attach handshake, prepared bridge,
and protocol-level terminal lifecycle. It uses the generic transport's internal
native length-prefixed channel callbacks so inbound frames are decoded without
crossing JavaScript first. The command wrapper uses the public persistent
exec-channel API.

Terminal and graphics payloads cross the Whip UniFFI/JSI boundary as binary
`ArrayBuffer` values. Metadata and low-frequency controls use typed arguments
and records; terminal bytes are never JSON, base64, or UTF-8 decoded in the
adapter.

WP4 pairing remains a separate QR-pinned bootstrap SSH connection and is
intentionally not exposed by the public transport package.

## App API

Import the client and its types from this package:

```ts
import SSHClient, { PtyType, type LsResult } from 'react-native-whip-ssh';
```

Generic SSH consumers should install and import `react-native-russh` instead.
This adapter is not published independently.

Run the terminal-path copy benchmark from the repository root:

```sh
npm run benchmark:terminal-bridge
```

## Provenance

The public `SSHClient` shape originated in the
[`react-native-ssh-sftp`](https://github.com/enatividad/react-native-ssh-sftp)
fork family, including the Dylan Kenneally fork previously vendored under its
package name. Whip now maintains that compatibility facade as part of its own
Russh implementation; none of the upstream native transports are included or
linked.

Whip's package and transport changes are licensed under
`AGPL-3.0-or-later`; see the repository root `LICENSE`.
