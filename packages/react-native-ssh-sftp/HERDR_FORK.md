# Herdr SSH package fork

This directory is a project-owned fork of
`@dylankenneally/react-native-ssh-sftp` 1.11.0. The root package depends on it
through a local `file:` dependency, so `npm install` creates a symlink instead
of modifying installed files with `patch-package`.

Herdr-specific changes:

- preserve the raw PTY stream and expose a line-shell mode that forwards large
  newline-delimited Herdr frames in bounded React Native event chunks;
- run Herdr protocol 17 `remote-client-bridge` as a persistent binary exec
  channel for the visible terminal, including attach, input, resize, scrolling,
  and terminal-id-tagged chunked ANSI frame events;
- connect directly to Herdr's Unix API socket through an OpenSSH stream-local
  channel for newline-delimited event subscriptions on the same authenticated
  session;
- run sequential Herdr control commands through one persistent non-PTY shell
  channel, with response markers framed across native event chunks, so normal
  operation stays at three SSH channels instead of opening an exec channel for
  every command;
- configure JSch server-alive probes so a half-open mobile SSH connection is
  closed after three missed 5-second probes, allowing the app to reconnect
  instead of leaving terminal and event streams frozen;
- subscribe to exec-channel output before starting short-lived Herdr commands,
  preventing their first response from being lost on fast remote hosts;
- expose PTY resizing on Android and in the JavaScript API;
- close shell/SFTP streams synchronously during disconnect so asynchronous
  cleanup cannot race client-pool removal and crash the Android process;
- use JSch 2.28.4 and `bcprov-jdk18on` 1.85 so Ed25519 OpenSSH keys work on
  Android runtimes that do not provide Java 15's EdDSA implementation;
- inspect private keys in memory, including encrypted keys, and expose their
  SHA-256 fingerprint and key type to the host editor.

When updating from upstream, compare and merge these changes in this directory,
then run the root test, typecheck, lint, and Android build commands. Never edit
the symlinked copy under `node_modules`.
