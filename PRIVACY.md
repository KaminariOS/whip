# Privacy notes

Whip is a direct Android-to-host client. The project does not operate an intermediary service for your Herdr session and does not intentionally include advertising or product analytics SDKs.

## Data handled by the app

Whip may process and store:

- host profile metadata such as hostname, port, username, Herdr command, and session name;
- SSH passwords, private keys, and key passphrases;
- Herdr workspace, pane, agent, and terminal content received from your host;
- device-local terminal and notification preferences; and
- a terminal background image selected by the user.

Credentials are stored through Android Keystore. When supported and enabled by the device, Whip also uses Android Block Store for an encrypted, device-authenticated recovery copy. Block Store availability and cloud backup behavior are controlled by Google Play services and the user's device/account settings.

## Network communication

Whip connects directly to the SSH host configured by the user. Herdr data and terminal traffic travel through that SSH connection. Tailscale, the SSH host, Android, Google Play services, and any build distribution service have their own privacy practices outside this project's control.

SSH host keys are not currently verified. Use Whip only on a trusted Tailnet until that limitation is fixed.

## Notifications and speech

Blocked/done notifications, vibration, and optional speech announcements are produced on the Android device. Notification text may be visible on the lock screen according to the user's Android notification settings.

## Removing data

Deleting a saved host profile removes its associated local credential and requests deletion of its Block Store recovery entry. Clearing the app's storage removes device-local profiles, credentials, preferences, and imported background images. Android or Google account backup retention may be governed separately by the operating system and Google Play services.

## Sharing diagnostics

Never post raw credentials, private keys, Tailnet addresses, or sensitive terminal output in an issue or Discussion. Review and redact screenshots and logs before sharing them.

Privacy questions may be opened in [GitHub Discussions](https://github.com/KaminariOS/whip/discussions). Potential security problems should use the private process in [SECURITY.md](SECURITY.md).
