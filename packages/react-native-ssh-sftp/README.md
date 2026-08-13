# SSH and SFTP client library for React Native

SSH and SFTP client library for React Native on iOS and Android.

[![Compile package](https://github.com/dylankenneally/react-native-ssh-sftp/actions/workflows/compile.yml/badge.svg)](https://github.com/dylankenneally/react-native-ssh-sftp/actions/workflows/compile.yml) [![Publish package to npmjs.com](https://github.com/dylankenneally/react-native-ssh-sftp/actions/workflows/publish.yml/badge.svg)](https://github.com/dylankenneally/react-native-ssh-sftp/actions/workflows/publish.yml) [![View documentation](https://img.shields.io/badge/View-documentation-blue)](https://dylankenneally-react-native-ssh-sftp-96.mintlify.app)

## Full documentation

A full set of [documentation is available on Mintlify](https://dylankenneally-react-native-ssh-sftp-96.mintlify.app), which includes:

1. Installation
1. Quick start guide
1. API reference
1. Core concepts
1. Guides

Below is a quick installation and usage guide to get up and running. The [full documentation](https://dylankenneally-react-native-ssh-sftp-96.mintlify.app) is recommended in addition to the below.

> [!NOTE]
> This project-owned fork supports strict host-key verification through
> `SSHClient.setKnownHosts()` on Android and on the Rust-based iOS backend.

## Installation

```bash
npm install @dylankenneally/react-native-ssh-sftp
```

### iOS

This project-owned fork builds its iOS SSH transport from Rust and does not
require NMSSH or OpenSSL. The current Expo SDK requires iOS 16.4 or newer. Run
the repository-pinned CocoaPods bundle from your `./ios` directory on macOS.

The iOS backend currently supports Ed25519 private-key authentication and
password authentication. RSA private keys remain supported by Android, but are
intentionally disabled on iOS until the unpatched RUSTSEC-2023-0071 timing issue
in Russh's RSA dependency has a safe upgrade path.

```bash
cd ios
bundle exec pod install
cd -
```

> [!TIP]
> Adding a `postinstall` script to your `package.json` file to run `pod install` after `npm install` is a good idea. The [`pod-install`](https://www.npmjs.com/package/pod-install) package is a good way to do this.
>
> ```json
> {
>   "scripts": {
>     "postinstall": "npx pod-install",
>   }
> }
> ```

### Android

No additional steps are needed for Android.

### Linking

This project has been updated to use React Native v84 (the latest at the time of writing, Feb 2026) - which means that manual linking is not required.

## Usage

All functions that run asynchronously where we have to wait for a result returns Promises that can reject if an error occurred.

### Create a client using password authentication

```javascript
import SSHClient from '@dylankenneally/react-native-ssh-sftp';

SSHClient.connectWithPassword(
  "10.0.0.10",
  22,
  "user",
  "password"
).then(client => {/*...*/});
```

### Create a client using public key authentication

```javascript
import SSHClient from 'react-native-ssh-sftp';

SSHClient.connectWithKey(
  "10.0.0.10",
  22,
  "user",
  privateKey="-----BEGIN RSA...",
  passphrase
).then(client => {/*...*/});
```

#### Public key authentication is also supported

```plaintext
{privateKey: '-----BEGIN RSA......'}
{privateKey: '-----BEGIN RSA......', publicKey: 'ssh-rsa AAAAB3NzaC1yc2EA......'}
{privateKey: '-----BEGIN RSA......', publicKey: 'ssh-rsa AAAAB3NzaC1yc2EA......', passphrase: 'Password'}
```

### Close client

```javascript
client.disconnect();
```

### Execute SSH command

```javascript
const command = 'ls -l';
client.execute(command)
  .then(output => console.warn(output));
```

### Shell

#### Start shell

- Supported ptyType: vanilla, vt100, vt102, vt220, ansi, xterm

```javascript
const ptyType = 'vanilla';
client.startShell(ptyType)
  .then(() => {/*...*/});
```

#### Read from shell

```javascript
client.on('Shell', (event) => {
  if (event)
    console.warn(event);
});
```

#### Write to shell

```javascript
const str = 'ls -l\n';
client.writeToShell(str)
  .then(() => {/*...*/});
```

#### Close shell

```javascript
client.closeShell();
```

### SFTP

#### Connect SFTP

```javascript
client.connectSFTP()
  .then(() => {/*...*/});
```

#### List directory

```javascript
const path = '.';
client.sftpLs(path)
  .then(response => console.warn(response));
```

#### Create directory

```javascript
client.sftpMkdir('dirName')
  .then(() => {/*...*/});
```

#### Rename file or directory

```javascript
client.sftpRename('oldName', 'newName')
  .then(() => {/*...*/});
```

#### Remove directory

```javascript
client.sftpRmdir('dirName')
  .then(() => {/*...*/});
```

#### Remove file

```javascript
client.sftpRm('fileName')
  .then(() => {/*...*/});
```

#### Download file

```javascript
client.sftpDownload('[path-to-remote-file]', '[path-to-local-directory]')
  .then(downloadedFilePath => {
    console.warn(downloadedFilePath);
  });

// Download progress (setup before call)
client.on('DownloadProgress', (event) => {
  console.warn(event);
});

// Cancel download
client.sftpCancelDownload();
```

#### Upload file

```javascript
client.sftpUpload('[path-to-local-file]', '[path-to-remote-directory]')
  .then(() => {/*...*/});

// Upload progress (setup before call)
client.on('UploadProgress', (event) => {
  console.warn(event);
});

// Cancel upload
client.sftpCancelUpload();
```

#### Close SFTP

```javascript
client.disconnectSFTP();
```

## Example app

You can find a very simple example app for the usage of this library [here](https://github.com/dylankenneally/react-native-ssh-sftp-example).

## Credits

This package wraps the following libraries, which provide the actual SSH/SFTP functionality:

- [Russh](https://github.com/Eugeny/russh) for iOS
- [JSch](http://www.jcraft.com/jsch/) for Android ([from Matthias Wiedemann fork](https://github.com/mwiede/jsch))

This package is a fork of Emmanuel Natividad's [react-native-ssh-sftp](https://github.com/enatividad/react-native-ssh-sftp) package. The fork chain from there is as follows:

1. [Gabriel Paul "Cley Faye" Risterucci](https://github.com/KeeeX/react-native-ssh-sftp)
1. [Bishoy Mikhael](https://github.com/MrBmikhael/react-native-ssh-sftp)
1. [Qian Sha](https://github.com/shaqian/react-native-ssh-sftp)
