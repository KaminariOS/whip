# Contributing to Whip

Thank you for helping improve Whip. Whip is an independent, unofficial, experimental Android client for Herdr. Small, focused contributions with a clear test plan are easiest to review.

## Start with the right channel

- Ask usage questions and discuss early ideas in [GitHub Discussions](https://github.com/KaminariOS/whip/discussions).
- Use the issue forms for confirmed bugs and scoped feature requests.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
- Open a pull request when the change is ready for review.

For a substantial feature or architecture change, start a Discussion before investing significant time. This helps confirm scope without turning an early idea into a tracking issue prematurely.

## Development setup

Whip requires Node.js 22, JDK 17, and the Android 36 SDK. It uses a custom Expo development build and cannot run in Expo Go.

On NixOS, the repository development shell provides the complete toolchain:

```bash
nix develop
npm ci
npm run android
```

For other systems, install Node.js 22, JDK 17, Android SDK Platform 36, Build Tools 36.0.0, NDK 27.1.12297006, and CMake 3.22.1. Then run:

```bash
npm ci
npm run android
```

See [DEBUG.md](DEBUG.md) for the emulator and device troubleshooting loop, and [ARCHITECTURE.md](ARCHITECTURE.md) before changing transport, terminal, credential, or state ownership.

## Validate a change

Run the checks relevant to your change. Before requesting review, the full validation set is:

```bash
npx expo-doctor
npx tsc --noEmit
npm run lint
npm test -- --runInBand
npx expo export --platform android
cd android
./gradlew app:lintRelease app:assembleDebug --no-daemon
```

Document any check you could not run and why.

## Pull request guidance

- Keep one logical change per pull request.
- Explain the user-visible result and how you verified it.
- Add or update tests for behavior changes.
- Include before/after screenshots or a short recording for UI changes.
- Preserve the Android-only product boundary unless a proposal has been discussed first.
- Use conventional commit subjects such as `fix:`, `feat:`, `docs:`, `ci:`, `test:`, or `chore:`.
- Do not mix dependency upgrades or generated files into an unrelated change.

## Security and privacy

Never place SSH passwords, private keys, passphrases, Tailnet credentials, host contents, or captured terminal secrets in issues, logs, screenshots, fixtures, or commits. Redact hostnames and Tailnet IP addresses when they are not necessary to reproduce a problem.

Whip currently lacks SSH host-key verification. Do not weaken or remove the warning around that limitation. Changes to credential storage, Android backup behavior, host trust, or release signing require an explicit security review.

## Licensing and provenance

Only submit work you have the right to contribute. Identify copied, adapted, generated, or ported material and preserve its required notices. Do not copy implementation code from Herdr or another project merely because it is visible on GitHub.

Unless explicitly stated otherwise, accepted contributions are licensed under `AGPL-3.0-or-later`, as described in the repository's root [LICENSE](LICENSE). If licensing or provenance is unclear, pause and ask a maintainer before submitting the work.
