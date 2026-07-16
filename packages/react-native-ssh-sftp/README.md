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

> [!WARNING]
> **Host key verification is not performed.** This library does not verify or pin the remote server's host key (on Android `StrictHostKeyChecking` is disabled, and on iOS the host key is not checked), so connections are susceptible to man-in-the-middle attacks. Until this is addressed, only connect over networks you trust. See the [security guide](https://dylankenneally-react-native-ssh-sftp-96.mintlify.app/guides/security) for details.

## Installation

```bash
npm install @dylankenneally/react-native-ssh-sftp
```

### iOS

Update your `Podfile` to use the [aanah0's fork](https://github.com/aanah0/NMSSH) of [NMSSH](https://github.com/NMSSH/NMSSH). Note that we use the forked version to give us a required later version of libssh. Your `Podfile` is located in your React Native project at `./ios/Podfile`.

```ruby
target '[your project's name]' do
  pod 'NMSSH', :git => 'https://github.com/aanah0/NMSSH.git' # <-- add this line
  # ... rest of your target details ...
end
```

And then run `pod install` in your `./ios` directory.

```bash
cd ios
pod install
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

#### Having OpenSSL issues on iOS?

If you are using [Flipper](https://fbflipper.com/) to debug your app, it will already have a copy of OpenSSL included. This can cause issues with the version of OpenSSL that NMSSH uses. You can disable flipper by removing/commenting out the `flipper_configuration => flipper_config,` line in your `Podfile`.

### Android

No additional steps are needed for Android.

### Linking

This project has been updated to use React Native v84 (the latest at the time of writing, Feb 2026) - which means that manual linking is not required.

## Usage

All functions that run asynchronously where we have to wait for a result returns Promises that can reject if an error occurred.

> [!NOTE]
> On iOS, this package currently doesn't support the simulator, you will need to have your app running on a physical device. If you  would like to know more about this, see [this issue](https://github.com/dylankenneally/react-native-ssh-sftp/issues/20). I'd welcome a PR to resolve this.
>

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

- [NMSSH](https://github.com/aanah0/NMSSH) for iOS
- [JSch](http://www.jcraft.com/jsch/) for Android ([from Matthias Wiedemann fork](https://github.com/mwiede/jsch))

This package is a fork of Emmanuel Natividad's [react-native-ssh-sftp](https://github.com/enatividad/react-native-ssh-sftp) package. The fork chain from there is as follows:

1. [Gabriel Paul "Cley Faye" Risterucci](https://github.com/KeeeX/react-native-ssh-sftp)
1. [Bishoy Mikhael](https://github.com/MrBmikhael/react-native-ssh-sftp)
1. [Qian Sha](https://github.com/shaqian/react-native-ssh-sftp)
