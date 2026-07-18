# Security policy

## Current status

Whip is an experimental preview. There is no supported stable release yet.

> **Experimental preview. Connect only through a trusted Tailnet. SSH host keys are not yet verified.**

The current SSH dependency does not verify or pin the server host key. A changed or impersonated host therefore cannot be detected reliably. This is a known release blocker, not a production security boundary.

Preview APKs are also preview-signed, and their signing identity may change before a stable release. Verify the SHA-256 checksum attached to each GitHub prerelease.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability or include credentials, private keys, Tailnet details, or private terminal output in a report.

Use [GitHub private vulnerability reporting](https://github.com/KaminariOS/whip/security/advisories/new). Include:

- the affected commit or preview tag;
- the Android version and device architecture;
- clear reproduction steps;
- the expected and observed security impact; and
- a minimal proof of concept with all secrets removed.

You should receive an acknowledgment within seven days. This project does not currently operate a vulnerability bounty program.

## Supported versions

Only the latest commit on `main` and the newest GitHub prerelease are considered for security fixes. Older preview builds may be closed as unsupported after the reporter confirms whether the issue still exists on the latest code.

## Known limitation reports

The absence of SSH host-key verification is already tracked. A report about a new bypass, credential exposure, unsafe backup behavior, or another consequence beyond that documented limitation is still welcome through private reporting.
