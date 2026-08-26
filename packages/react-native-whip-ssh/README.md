# react-native-whip-ssh

Whip's single native SSH and Herdr module. It owns the Tokio runtime, Russh
sessions, ProxyJump chain, known-host verification, shell/exec/SFTP/forwarding,
Herdr control and event streams, terminal bridges, host-state reconciliation,
agent transcript streams, reconnect restoration, and WP4 pairing.

`HostRuntime` owns an authenticated `SshSession` directly. Herdr API requests
and long-lived streams call typed Rust methods on that session; no C ABI,
dynamic library lookup, callback context, or JSON dispatch exists between the
SSH and Herdr implementations. React Native sends semantic requests and
receives typed results/events; raw Herdr JSON never crosses the boundary.

The same crate owns the Herdr terminal codec, Welcome/Attach handshake,
prepared bridge, and protocol-level terminal lifecycle. Raw and
length-prefixed channels stay in Rust so control messages and terminal frames
are decoded without crossing JavaScript first.

Terminal and graphics payloads cross the Whip UniFFI/JSI boundary as binary
`ArrayBuffer` values. Metadata and low-frequency controls use typed records and
data-carrying enums. Terminal bytes are never JSON, base64, or UTF-8 decoded in
the adapter.

WP4 pairing remains a logically separate QR-pinned bootstrap module but shares
the Whip crate, executor, native module, and platform library.

## App API

Import the client and its types from this package:

```ts
import SSHClient, { PtyType, type LsResult } from 'react-native-whip-ssh';
```

The JavaScript `SSHClient` export is one facade, not a subclass layered over a
second transport. Whip host connections use its typed `HostRuntime`; generic
methods retained for key management and native diagnostics call the same native
module and Rust implementation.

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
