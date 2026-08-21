# react-native-whip-ssh

Private Whip-owned adapter over [`react-native-russh`](../react-native-russh).
It adds WP3 QR pairing and Herdr bridge/stream behavior while keeping those
product protocols out of the public transport API.

## App API

Import the client and its types from this package:

```ts
import SSHClient, { PtyType, type LsResult } from 'react-native-whip-ssh';
```

Generic SSH consumers should install and import `react-native-russh` instead.
This adapter is not published independently.

## Provenance

The public `SSHClient` shape originated in the
[`react-native-ssh-sftp`](https://github.com/enatividad/react-native-ssh-sftp)
fork family, including the Dylan Kenneally fork previously vendored under its
package name. Whip now maintains that compatibility facade as part of its own
Russh implementation; none of the upstream native transports are included or
linked.

Whip's package and transport changes are licensed under
`AGPL-3.0-or-later`; see the repository root `LICENSE`.
