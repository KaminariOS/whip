# Whip roadmap

Whip is an experimental, unofficial Android client for Herdr. This roadmap communicates priorities; it is not a promise of dates or compatibility.

## Before a stable release

- Implement SSH known-host verification with explicit first-connect trust and changed-key rejection.
- Establish a stable Android release-signing identity and documented release process.
- Publish a tested Android device, architecture, and Herdr-version compatibility matrix.
- Add a concise visual walkthrough and repeatable preview-installation path.

## Next

- Replace repeated CLI polling with a persistent Herdr API stdio bridge, events, and capability negotiation.
- Improve terminal release semantics and restoration after Android process death.
- Expand native Herdr agent and workflow actions without reproducing the management TUI.
- Improve reconnection diagnostics and stale-state visibility.
- Add accessibility and terminal ergonomics testing across a wider range of Android devices.

## Later or exploratory

- Additional device-local customization and notification controls.
- Broader architecture support for preview APKs.
- Community-requested Herdr workflows that fit the Android product boundary.

iOS is not currently a supported target. Proposals that substantially change the product boundary should begin in [GitHub Discussions](https://github.com/KaminariOS/whip/discussions).

Implementation detail and architectural constraints live in [ARCHITECTURE.md](ARCHITECTURE.md).
