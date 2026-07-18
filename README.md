# Whip

<img src="assets/icon.png" alt="Whip app icon" width="128">

Whip is an independent, unofficial Android client for supervising and controlling [Herdr](https://github.com/ogulcancelik/herdr) over SSH on a Tailscale network.

Whip is not developed, maintained, or endorsed by the Herdr project or its authors.

> [!WARNING]
> **Experimental preview. Connect only through a trusted Tailnet. SSH host keys are not yet verified.**

[![CI](https://github.com/KaminariOS/whip/actions/workflows/ci.yml/badge.svg)](https://github.com/KaminariOS/whip/actions/workflows/ci.yml)
[![CodeQL](https://github.com/KaminariOS/whip/actions/workflows/codeql.yml/badge.svg)](https://github.com/KaminariOS/whip/actions/workflows/codeql.yml)

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
- Android Keystore credential storage with encrypted, device-authenticated Block Store recovery
- Named Herdr sessions and configurable Herdr executable path

## Requirements

- Android phone and laptop connected to the same Tailscale network
- SSH server running on the laptop
- Herdr installed on the laptop
- Node.js 22+
- Android SDK and JDK 17 for local native builds

Whip currently supports Android only. The checked-in iOS project is not a supported release target.

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

The Nix development shell provides Node.js, JDK 17, and the required Android SDK/NDK versions. Outside Nix, install those tools separately and expose the Android SDK through `ANDROID_HOME`.

## Experimental APKs

Maintainers can publish an ARM64 preview APK through the manual **Build Android APK** workflow. Preview builds are published as GitHub prereleases and are not production releases. Their signing identity may change before Whip reaches a stable release.

Before installing a preview:

1. Read the [security policy](SECURITY.md) and [privacy notes](PRIVACY.md).
2. Confirm that the phone and Herdr host are on a Tailnet you trust.
3. Download the APK and checksum from [GitHub Releases](https://github.com/KaminariOS/whip/releases).
4. Verify it with `sha256sum -c whip-experimental-arm64.apk.sha256`.

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

The current SSH dependency does not pin host keys. Use the app only over a trusted Tailscale network until host-key verification is added. See [SECURITY.md](SECURITY.md) for the current security posture and private reporting instructions.

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

## Community

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
- Ask usage and design questions in [GitHub Discussions](https://github.com/KaminariOS/whip/discussions).
- Use the issue forms for reproducible bugs and scoped feature requests.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- Review the [roadmap](ROADMAP.md) for current priorities.

Whip is especially looking for feedback about Android device compatibility, real-world Herdr workflows, terminal ergonomics, and safe SSH trust UX.
