# Herdr SSH package fork

This directory is a project-owned fork of
`@dylankenneally/react-native-ssh-sftp` 1.11.0. The root package depends on it
through a local `file:` dependency, so `npm install` creates a symlink instead
of modifying installed files with `patch-package`.

Herdr-specific changes:

- preserve raw PTY chunks instead of reading shell output one line at a time;
- expose PTY resizing on Android and in the JavaScript API;
- close shell/SFTP streams synchronously during disconnect so asynchronous
  cleanup cannot race client-pool removal and crash the Android process;
- use JSch 2.28.4 and `bcprov-jdk18on` 1.85 so Ed25519 OpenSSH keys work on
  Android runtimes that do not provide Java 15's EdDSA implementation.

When updating from upstream, compare and merge these changes in this directory,
then run the root test, typecheck, lint, and Android build commands. Never edit
the symlinked copy under `node_modules`.
