# SSH API provenance

Whip's `SSHClient` facade descends from Emmanuel Natividad's
`react-native-ssh-sftp` API and subsequent forks maintained by Gabriel Paul
"Cley Faye" Risterucci, Bishoy Mikhael, Qian Sha, and Dylan Kenneally.

The upstream fork family is available under its original MIT terms. Whip has
replaced its native implementations with a project-owned Rust/Russh transport,
generated UniFFI bindings, and React Native New Architecture installers. Those
Whip changes are licensed under `AGPL-3.0-or-later`.

This notice preserves the origin of the compatibility API without implying
that Whip still installs, links, or executes the Dylan Kenneally package.
