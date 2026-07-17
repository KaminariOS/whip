# Herdr SSH package fork

This directory is a project-owned fork of
`@dylankenneally/react-native-ssh-sftp` 1.11.0. The root package depends on it
through a local `file:` dependency, so `npm install` creates a symlink instead
of modifying installed files with `patch-package`.

Herdr-specific changes:

- preserve the raw PTY stream and expose a line-shell mode that forwards large
  newline-delimited Herdr frames in bounded React Native event chunks;
- run Herdr protocol 16 `remote-client-bridge` as persistent per-terminal binary
  exec channels multiplexed through the existing authenticated SSH session,
  including prewarmed handshake, terminal attach, input, resize, scrolling, and
  terminal-id-tagged chunked ANSI frame events;
- run the newline-delimited `nc -U` event subscription as a separate exec
  channel on that same authenticated session;
- configure JSch server-alive probes so a half-open mobile SSH connection is
  closed after three missed 5-second probes, allowing the app to reconnect
  instead of leaving terminal and event streams frozen;
- subscribe to exec-channel output before starting short-lived Herdr commands,
  preventing their first response from being lost on fast remote hosts;
- expose PTY resizing on Android and in the JavaScript API;
- close shell/SFTP streams synchronously during disconnect so asynchronous
  cleanup cannot race client-pool removal and crash the Android process;
- use JSch 2.28.4 and `bcprov-jdk18on` 1.85 so Ed25519 OpenSSH keys work on
  Android runtimes that do not provide Java 15's EdDSA implementation.

When updating from upstream, compare and merge these changes in this directory,
then run the root test, typecheck, lint, and Android build commands. Never edit
the symlinked copy under `node_modules`.
