# HerdR Remote

Expo Android client for supervising and controlling [Herdr](https://github.com/ogulcancelik/herdr) over SSH on a Tailscale network.

Herdr itself is not exposed to the network and does not need to be modified. Herdr's management UI is rebuilt as native Android screens. The xterm-compatible view is used only when the user attaches directly to a selected agent or shell pane.

## Features

- Native attention queue for working, blocked, done, idle, and unknown agents
- Native spaces, tabs, panes, and agent navigation
- Create, focus, rename, and close spaces and tabs
- Split, zoom, rename, inspect, send keys to, and close panes
- Launch agents and send direct prompts or pane commands
- Immersive Voltius-style workspace, tab, and pane terminal navigation
- Direct interactive terminal bridge for each selected pane
- ANSI colors, modifier/special keys, touch scrolling, double-tap Tab, and live resizing
- Android vibration and local notifications for blocked/done transitions
- Optional Expo Speech announcements
- Password and private-key authentication
- Optional credential storage in Android Keystore
- Named Herdr sessions and configurable Herdr executable path

## Requirements

- Android phone and laptop connected to the same Tailscale network
- SSH server running on the laptop
- Herdr installed on the laptop
- Node.js 22+
- Android SDK and JDK 17 for local native builds

Confirm the same connection outside the app first:

```bash
ssh user@laptop.tailnet.ts.net 'herdr status server --json'
```

If `herdr` is not in the non-interactive SSH `PATH`, enter its absolute path in the app's **Command** field, for example `/home/user/.local/bin/herdr`.

## Development

This project uses Expo SDK 57 with a custom development build. It cannot run in Expo Go because SSH, Android Keystore, and the patched PTY stream use native modules.

```bash
npm install
npm start
```

In another terminal, build and install the Expo development client:

```bash
npm run android
```

On NixOS, enter the included shell first:

```bash
nix develop
npm run android
```

The Android SDK still needs to be installed and exposed through `ANDROID_HOME`.

## EAS builds

After authenticating and initializing the Expo project:

```bash
npx eas-cli build --profile development --platform android
npx eas-cli build --profile preview --platform android
```

The `development` profile creates an Expo development client. The `preview` profile creates an installable APK.

## Connection behavior

1. Enter the laptop's Tailscale DNS name or `100.x.y.z` address.
2. Authenticate with the same SSH user and credentials used by Termius.
3. The app polls Herdr's workspace, tab, pane, and agent CLI surfaces every 2.5 seconds while foregrounded.
4. Herdr session management stays in native Android screens; only the selected pane's shell or agent TUI is rendered as a terminal.
5. Opening **Session** runs `herdr terminal session control <terminal_id> --takeover` and exchanges Herdr's JSON frame/input/resize protocol over an SSH PTY.
6. Native actions call existing commands such as `herdr agent send`, `herdr pane split`, and `herdr workspace focus`.

The current SSH dependency does not pin host keys. Use the app only over a trusted Tailscale network until host-key verification is added.

## Validation

```bash
npx expo-doctor
npx tsc --noEmit
npm run lint
npm test -- --runInBand
npx expo export --platform android
```

The SSH bridge is a project-owned local package at
`packages/react-native-ssh-sftp`. It preserves raw PTY chunks, supports terminal
resizing, and uses current Android SSH crypto for OpenSSH Ed25519 keys. The root
dependency uses `file:packages/react-native-ssh-sftp`; do not edit or patch the
symlink under `node_modules`.
