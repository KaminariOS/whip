# react-native-whip-ssh

Private Whip-owned adapter over [`react-native-russh`](../react-native-russh).
It exposes WP4 QR pairing and Herdr bridge/stream behavior while keeping those
product protocols out of the public transport API.

The adapter subclasses the public `SSHClient`. Direct Herdr API requests and
the long-lived event feed use raw OpenSSH Unix-socket channels. Herdr terminal
negotiation and codec behavior use the public length-prefixed channel API, and
the command wrapper uses the public persistent exec-channel API.

Herdr terminal events expose their binary payload as an `ArrayBufferView` into
the received frame. Consumers must honor the view's `byteOffset` and
`byteLength`; Whip converts that view only at the WebView renderer boundary.

WP4 pairing is the package's only native Rust implementation. It opens a
separate QR-pinned bootstrap SSH connection and is intentionally not exposed by
the public transport package.

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
