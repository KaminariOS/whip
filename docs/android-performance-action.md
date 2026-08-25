# Android terminal latency action

`Record Android terminal latency` is a manual GitHub Actions workflow for the
real USB-connected Android path. It intentionally uses a physical device rather
than a hosted emulator: emulator GPU scheduling and host-loopback networking are
not representative of typing-to-visible latency on a phone.

## Runner preparation

Register a Linux self-hosted runner for the repository and give it the custom
label `android-perfetto`. The runner needs:

- Nix with flakes enabled;
- one authorized arm64 Android device visible to `adb`;
- the Whip app data containing a saved host profile and its credentials.

The repository's `google-play` environment must contain the same upload-signing
secrets as the release build. A dispatched job remains queued unless an online
runner has the required label. Keep the phone dedicated and unlocked during the
run; the workflow installs the upload-signed release in place, wakes the phone,
launches Whip, changes orientation during the scenario, and restores the
original orientation setting. It never uninstalls the app.

## Recording

Before dispatching the workflow:

1. Ensure the remote Herdr session already contains the cold target and
   comparison tabs.
2. Ensure both tab buttons are visible in Whip's terminal tab strip.
3. Choose a target that will not be the restored active tab. A fresh app process
   means that target has no renderer or bridge during this connection.
4. Run **Actions → Record Android terminal latency → Run workflow**.
5. Enter the labels exactly as shown in the tab strip. The default three-minute
   settling period keeps the restored SSH/Herdr connection alive before capture.

The device automation selects the untouched tab and immediately injects
`aaaaa`, optionally rotates, switches to the comparison tab, returns to the now
warm target, injects `bbbbb`, and repeats the rotation.

The uploaded artifact contains:

- `terminal-input.perfetto-trace`, the raw Perfetto capture;
- `terminal-input.csv`, cold/warm additive input stages;
- `terminal-resize.csv`, cold/warm resize-burst stages and redundant-request
  counts;
- `terminal-resize-events.csv`, the ordered fit/xterm source, dimensions, cell
  size, and scheduling/fit timing for every resize request;
- `terminal-input.md`, the input waterfall plus resize comparison and request
  sequence.

The waterfall is also written to the GitHub Actions job summary. Terminal input
and output contents are never stored in the report or slice names.
