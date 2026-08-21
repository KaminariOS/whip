# whip-pair prototype

[![crates.io](https://img.shields.io/crates/v/whip-pair.svg)](https://crates.io/crates/whip-pair)
[![PyPI](https://img.shields.io/pypi/v/whip-pair.svg)](https://pypi.org/project/whip-pair/)
[![npm](https://img.shields.io/npm/v/whip-pair.svg)](https://www.npmjs.com/package/whip-pair)

`whip-pair` is a direct, one-shot SSH public-key enrollment prototype for
Whip. It uses the host's existing SSH port: no relay, TLS listener, additional
firewall rule, pairing account, or `sshd_config` change is required.

The host creates a temporary Ed25519 credential and adds only its public half
to the current user's `authorized_keys` with `restrict` and a forced command.
The QR contains the private seed, SSH endpoint, username, and SSH host-key pin.
Whip uses that credential for one restricted exchange, the host user approves
the submitted permanent public key, and `whip-pair` removes the temporary
authorization.

## Install

All non-Nix installations require `ssh-keyscan` from an OpenSSH client package
to be available on `PATH`.

### uv

Run the native binary from PyPI without installing Rust:

```bash
uvx whip-pair
```

`uvx` is an alias for `uv tool run`; either form creates an isolated tool
environment and runs `whip-pair`. Published wheels support macOS and Linux on
ARM64 and x64.

### npm

Run the native binary from npm without installing Rust:

```bash
npx whip-pair
```

The npm package is a dependency-free launcher containing the same four native
binaries. Node.js 18 or newer is required.

### Cargo

Install the [published crate](https://crates.io/crates/whip-pair) with Rust 1.85
or newer:

```bash
cargo install --locked whip-pair
whip-pair
```

### Nix

Run the public version:

```bash
nix run github:KaminariOS/whip#whip-pair
```

Select a specific reachable address when needed:

```bash
nix run github:KaminariOS/whip#whip-pair -- serve --bind 192.168.1.10
```

If SSH is already listening on a nonstandard port, advertise it with
`--ssh-port`:

```bash
nix run github:KaminariOS/whip#whip-pair -- serve \
  --bind 192.168.1.10 \
  --ssh-port 2222
```

`--ssh-port` defaults to `22`. It does not open a new port; it must match the
existing SSH service reachable at the selected or advertised host. When no
`--bind` address is supplied, the interactive setup asks for this port and
offers `22` as the default. Passing `--ssh-port` skips that question.

From a local checkout:

```bash
nix run .#whip-pair
```

The Nix app includes `ssh-keyscan`. Automatic discovery requests Ed25519,
ECDSA, and RSA host keys in Whip's `russh` preference order. Use
`--ssh-fingerprint` to provide a fingerprint explicitly.

During development, print the underlying envelope:

```bash
nix run .#whip-pair -- serve --bind 192.168.1.10 --print-code
```

Exercise the SSH-only protocol with a disposable public key:

```bash
nix run .#whip-pair -- request \
  --code 'WP4:...' \
  --public-key ~/.ssh/id_ed25519.pub \
  --device-name 'Prototype client'
```

Inspect a copied envelope without exposing its temporary private seed:

```bash
nix run .#whip-pair -- inspect 'WP4:...'
```

## Prototype limitations

- The SSH server must use OpenSSH-compatible `authorized_keys`, support the
  `restrict` and `command` options, and read the current user's default
  `~/.ssh/authorized_keys` file.
- Automatic host-key discovery invokes `ssh-keyscan`; the Nix app supplies it.
- The terminal QR uses error-correction level L to stay compact.
- Whip's mobile scanner supports WP4. The `request` subcommand remains a
  protocol test client.

## Pairing protocol (WP4)

[![WP4 pairing sequence](docs/wp4-sequence.svg)](docs/wp4-sequence.mmd)

The canonical Mermaid source is
[`docs/wp4-sequence.mmd`](docs/wp4-sequence.mmd).
Render and validate the tracked SVG with:

```bash
nix shell nixpkgs#mermaid-cli -c mmdc \
  -i whip-pair/docs/wp4-sequence.mmd \
  -o whip-pair/docs/wp4-sequence.svg
```

### QR bootstrap envelope

The QR contains `WP4:` followed by Base45-encoded binary data.

| Field                       | Encoding                                            | Purpose                                     |
| --------------------------- | --------------------------------------------------- | ------------------------------------------- |
| Address type                | 1 byte                                              | `1` IPv4, `2` IPv6, or `3` hostname         |
| SSH host                    | 4 or 16 bytes, or 1-byte length plus ASCII hostname | Address selected or advertised by the host  |
| SSH port                    | 2-byte unsigned integer, big-endian                 | Existing SSH service port                   |
| SSH username                | 1-byte length plus ASCII                            | Existing local account                      |
| Temporary Ed25519 seed      | 32 random bytes                                     | Restricted SSH bearer credential            |
| SSH host-key SHA-256 digest | 32 bytes                                            | Pins the SSH server identity during pairing |

For an IPv4 address and a five-character username, the complete code is 120
characters and renders as a 37-module QR at error-correction level L. Expiry
is enforced by the running host process and is intentionally omitted.

### Host authorization and exchange

Before displaying the QR, `whip-pair` adds an entry equivalent to:

```text
restrict,command="whip-pair exchange --socket …" ssh-ed25519 AAAA… whip-pair-temporary
```

`restrict` disables shell access, PTY allocation, forwarding, agent forwarding,
X11, and user startup commands. The forced command accepts one bounded JSON
`EnrollmentRequest` on SSH stdin and relays it through a Unix socket in a
mode-`0700` temporary directory to the visible `whip-pair` process.

The parent process validates the submitted OpenSSH public key, displays its
SHA-256 fingerprint, and asks the local user to approve it. On approval it
appends the permanent key safely and idempotently, replies with an
`EnrollmentResponse`, removes the temporary entry, and exits. Rejection leaves
the one-shot invitation available until its TTL expires.

Whip verifies the SSH host key against the digest in the QR before sending any
enrollment data. After pairing, it stores the verified public host key in its
global known-hosts list, so the saved host does not require a second trust
prompt.

### Security properties and boundaries

- The QR is a short-lived bearer credential. Anyone who can scan it and reach
  SSH can request enrollment, but the key can invoke only the forced exchange
  command and the host still asks for approval.
- WP4 transfers a temporary private-key seed, never the private half of the
  permanent key being enrolled. Normal SSH authentication later proves
  possession of that permanent key.
- The temporary key is removed on success, expiry, or Ctrl-C. If the process is
  killed before cleanup, the leftover entry remains restricted and its forced
  command cannot connect to the vanished private Unix socket.
- Bare OpenSSH public keys understood by Whip's `ssh-key` parser are accepted.
  `authorized_keys` options are rejected, comments are preserved, and duplicate
  permanent keys are not appended.
- The writer refuses symlink targets and files not owned by the current user,
  locks updates, uses atomic replacement for removal, and creates `.ssh` and
  `authorized_keys` with modes `0700` and `0600` when needed.

## Publishing

The [`Publish whip-pair to crates.io`](https://github.com/KaminariOS/whip/actions/workflows/publish-whip-pair.yml)
workflow verifies the crate version, formatting, Clippy, tests, and package
contents before publishing. Crates.io trusts only `publish-whip-pair.yml` in
`KaminariOS/whip` with the protected `crates-io` environment. The workflow
uses a short-lived OIDC credential; GitHub stores no crates.io API token.

The [`Publish whip-pair to PyPI and npm`](https://github.com/KaminariOS/whip/actions/workflows/publish-whip-pair-packages.yml)
workflow builds native PyPI wheels and npm binaries for macOS and Linux on
ARM64 and x64. PyPI should trust `publish-whip-pair-packages.yml` with the
`pypi` environment. After the first npm release, npm should trust the same
workflow with the `npm` environment. Both registries then publish with
short-lived GitHub OIDC credentials and provenance instead of stored tokens.

PyPI supports a pending trusted publisher for the first release. npm requires
the package to exist before trusted publishing can be configured, so add a
short-lived `NPM_TOKEN` secret to the protected `npm` environment, manually run
the workflow once with **Publish the npm package** and **Bootstrap the first
npm release with NPM_TOKEN** enabled, configure npm trusted publishing, and
then delete the secret.

To release a version, update `version` in `whip-pair/Cargo.toml`,
`whip-pair/npm/package.json`, and the `mkWhipPair` version in `flake.nix`,
refresh `whip-pair/Cargo.lock`, and run:

```bash
nix develop -c cargo test --locked --manifest-path whip-pair/Cargo.toml
nix develop -c cargo publish --locked --dry-run \
  --manifest-path whip-pair/Cargo.toml
nix develop -c uvx maturin build --release --locked \
  --manifest-path whip-pair/Cargo.toml \
  --out whip-pair/dist
```

Commit those changes, then push a tag whose version matches `Cargo.toml`
exactly:

```bash
git tag whip-pair-v0.1.1
git push origin whip-pair-v0.1.1
```
