# whip-pair

Run Whip's direct, one-shot SSH public-key enrollment helper without installing
Rust:

```bash
npx whip-pair
```

The npm package contains the native `whip-pair` Rust binary for macOS and Linux
on ARM64 and x64. The host must also have `ssh-keyscan`, normally supplied by
its OpenSSH client package, on `PATH`.

See the [full documentation](https://github.com/KaminariOS/whip/tree/main/whip-pair)
for the protocol, security boundaries, and command-line options.
