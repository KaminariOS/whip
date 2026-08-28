# SSH API provenance

Whip previously shipped an `SSHClient` compatibility facade descended from
Emmanuel Natividad's `react-native-ssh-sftp` API and subsequent forks maintained
by Gabriel Paul "Cley Faye" Risterucci, Bishoy Mikhael, Qian Sha, and Dylan
Kenneally. That facade and its JavaScript adapter have been removed.

The upstream fork family is available under its original MIT terms. Whip's
current API consists of project-owned typed `NativeHostRuntime` and generated
UniFFI bindings backed by its Rust/Russh transport and React Native New
Architecture installers. Those Whip changes are licensed under
`AGPL-3.0-or-later`.

This notice preserves the historical API provenance without implying that Whip
still installs, links, executes, or exposes the Dylan Kenneally package or its
compatibility facade.
