# Android known-host backup verification

Whip stores `herdr.known-hosts.v1` in React Native AsyncStorage. On Android,
AsyncStorage uses an app-private SQLite database (`RKStorage` for the classic
backend and `AsyncStorage` for the next backend). Both
`res/xml/backup_rules.xml` and `res/xml/data_extraction_rules.xml` include the
entire Android `database` domain, so known hosts participate in cloud backup and
device-to-device transfer.

This is recovery support, not a persistence guarantee. Android controls backup
availability, timing, transport, quotas, user account association, and restore.
A true uninstall without an available backup can lose known hosts. Whip must
then show every SSH host key as unknown and require explicit fingerprint
verification; it never re-trusts a host automatically.

## Upgrade check

Use arm64 release APKs signed by the same upload key:

```bash
adb install android/app/build/outputs/apk/release/app-release.apk
# Trust host A in Whip and verify Known SSH hosts reports 1.
adb install -r android/app/build/outputs/apk/release/app-release.apk
# Launch Whip and verify host A remains present and connects without a new prompt.
```

## Backup/uninstall/restore check

Run this only on a disposable test installation because `adb uninstall`
deletes the app sandbox. Use a Play-enabled device or emulator with Android
backup enabled and the same Google account throughout.

```bash
adb install android/app/build/outputs/apk/release/app-release.apk
# Trust host A in Whip and verify Known SSH hosts reports 1.
adb shell bmgr enabled
adb shell bmgr backupnow io.github.kaminarios.whip
adb shell bmgr list sets
# Record the restore-set token printed above.
adb uninstall io.github.kaminarios.whip
adb install android/app/build/outputs/apk/release/app-release.apk
adb shell bmgr restore RESTORE_SET_TOKEN io.github.kaminarios.whip
# Launch Whip and verify host A is present and accepted without prompting again.
```

The application ID and signing identity must match the backed-up installation.
Some transports perform restore automatically at install time; `bmgr restore`
is useful for an explicit test when the active transport supports it. A missing
restore set or a transport that declines the package is a backup-unavailable
case, not a reason to weaken SSH host-key verification.
