# whip-pair prototype

`whip-pair` is a direct, one-shot SSH public-key enrollment prototype for
Whip. The host binds a selected network interface, displays a QR code carrying
a compact bootstrap containing only the pairing endpoint, a one-time token,
and the SHA-256 pin of an ephemeral TLS certificate. After pinned TLS is
established, the server sends the SSH profile, asks the local user to approve
the submitted key, appends it safely to `authorized_keys`, and exits.

This prototype intentionally has no relay and no permanent service.

The pairing listener uses TCP port `8765` by default. The port must be
reachable from the phone on the selected interface. On NixOS, scope the
firewall opening to Tailscale when that is the pairing network:

```nix
networking.firewall.interfaces.tailscale0.allowedTCPPorts = [ 8765 ];
```

Use `--port 0` only when the firewall already permits dynamically selected
ports, or choose another explicitly allowed port with `--port`.

## Run with Nix

Start the host-side pairing server:

```bash
nix run .#whip-pair
```

If multiple usable interfaces exist, select the one the phone can reach. The
QR is printed immediately afterward. During CLI development, add
`--print-code` to print the underlying envelope for copy/paste:

```bash
nix run .#whip-pair -- serve --bind 192.168.1.10 --print-code
```

Exercise the phone side with another checkout/terminal and a disposable
public key:

```bash
nix run .#whip-pair -- request \
  --code 'WP3:...' \
  --public-key ~/.ssh/id_ed25519.pub \
  --device-name 'Prototype client'
```

Inspect a copied envelope:

```bash
nix run .#whip-pair -- inspect 'WP3:...'
```

## Prototype limitations

- The development client does not yet prove possession of the submitted
  private key. Host approval, the one-time token, and pinned TLS are present;
  proof-of-possession and the final SSH verification belong in the next
  iteration before production use.
- Only bare Ed25519 public keys are accepted.
- SSH host-key discovery requires `ssh-keyscan` and an Ed25519 host key.
- The version 3 envelope is compact binary encoded as Base45. SSH metadata is
  delivered after pinned TLS, while expiry is enforced only by the server.
- The terminal QR uses error-correction level L to stay compact. Keep the
  terminal unobstructed while scanning it.
- Whip's mobile scanner supports this version 3 protocol. The `request`
  subcommand remains available as a protocol test client.
