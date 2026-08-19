Use nix develop
only build for the new arm arch
Expo rejected the plain localhost connection because this native project requires an explicit app scheme. Start Metro with the project’s whip scheme.
Expo’s --localhost mode bound only to IPv6 (::1), while Android’s USB reverse was reaching IPv4. I’m rebinding Metro on all interfaces and keeping traffic on the USB-forwarded localhost port.

## Android signing and preview installs

- Debug APKs use `android/debug.keystore`.
- Distribution release APKs use the upload keystore configured through
  `WHIP_UPLOAD_KEYSTORE_PROPERTIES` or
  `~/.config/whip/upload-keystore.properties`.
- A release APK signed with the upload key cannot update a debug-signed
  installation. Android requires the signing certificate to match.
- Build local release/preview APKs with the debug signing key so they can be
  installed over an existing debug build without deleting app data:

  ```bash
  ./gradlew :app:assembleRelease \
    -Pwhip.previewSigning=true \
    -PreactNativeArchitectures=arm64-v8a
  adb install -r android/app/build/outputs/apk/release/app-release.apk
  ```

- Do not uninstall the app to work around a signing mismatch without asking
  first. Uninstalling deletes the app sandbox, including databases, AsyncStorage,
  files, and Android Keystore entries.
- Android backup is enabled and database/file backup rules exist, but restore is
  not immediate or guaranteed. Locally wrapped credential keys are intentionally
  excluded, so backup restoration cannot be treated as a complete credential
  backup.
