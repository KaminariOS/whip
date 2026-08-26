# Whip architecture

## Product boundary

Whip is a mobile client for a Herdr server running on another machine. It never starts a local Herdr runtime, shell, or PTY on the device.

The app has two presentation modes:

- **Herdr control surfaces become mobile UI.** Herd status, workspaces, tabs, panes, agent actions, settings, notifications, and connection state are React Native screens and sheets backed by structured Herdr state.
- **Pane terminals remain terminals.** When a user opens a shell or agent pane, the app attaches to that pane's terminal stream and renders its ANSI/TUI output faithfully in the terminal renderer.

The app must not render the full Herdr management TUI in a terminal and place mobile controls around it. Herdr's TUI is one client presentation; Whip is another presentation over the same server-owned state.

## Three planes

### Transport plane

The mobile device reaches a remote machine over SSH. A saved host profile owns host, port, username, authentication reference, Herdr binary path, named Herdr session, optional jump host, and optional agent-forwarding setting.

Metadata is stored in AsyncStorage. Passwords, private keys, and passphrases are stored through the platform credential store and referenced by profile ID; they must never be embedded in profile JSON, logs, screenshots, or fixtures. Android may back up only AES-GCM ciphertext, with its recovery token separated into Block Store. Global SSH keychain secrets are excluded from that recovery path.

Both platforms use the shared Rust/Russh transport. It loads one process-wide OpenSSH-compatible known-host repository, returns unknown keys for explicit fingerprint approval, and rejects changed keys. Direct hosts and every jump-host hop follow the same rule.

### Control plane

The control plane reads and mutates structured Herdr server state:

- server/version/capabilities
- session snapshot
- workspaces and worktrees
- tabs and panes
- agents, status, metadata, and recent output
- create, focus, rename, split, resize, send, close, and launch actions

Whip opens SSH stream-local channels directly to Herdr's local API socket. Short-lived request channels carry structured actions and snapshots; a persistent subscription channel carries events. Normal operation does not start a remote shell, poll JSON-producing CLI commands, or depend on private TUI layout/render messages.

If Whip needs a new server capability, it should be a neutral Herdr socket API method or event, not a mobile-specific endpoint and not a second source of runtime truth.

Herdr's Unix API accepts one normal request and then closes that socket
connection; only subscriptions remain open. Control requests therefore use
separate short-lived stream-local channels. Do not treat the API socket itself
as a multiplexed transport.
The first `session.snapshot` response also supplies the version and protocol, so
cold connections use it as the availability handshake instead of opening a
separate ping channel. Whip caches each resolved absolute socket path for the
life of the app process and re-resolves it through the current SSH session if a
cached path stops accepting channels.

### Terminal plane

Each opened Herdr terminal owns an independent SSH stream-local channel to the
server's client-protocol socket. The product-specific Rust bridge in
`react-native-whip-ssh` owns protocol validation, binary encoding/decoding, the
`Hello` / `Welcome` / `AttachTerminal` state machine, prepared connections, and
protocol-level cleanup. It composes directly with a product-neutral native
length-prefixed channel in `react-native-russh`; terminal frames do not travel
through a JavaScript codec or generic JSON event path. React Native sends
semantic input, resize, scroll, and close operations and receives typed control
events plus raw binary terminal/graphics payloads for the renderer. Do not
substitute the human-facing
`terminal attach` command: nesting that interface inside an SSH PTY leaks shell
chrome and breaks application-level input and resize behavior.

`TerminalAttach` is a direct pane connection. Its input bypasses Herdr's management
prefix router, so Whip must expose workspace, tab, and pane operations as native
actions. Ctrl/Alt and control bytes in the terminal key rail belong to the program
inside the pane; they are not Herdr navigation shortcuts.

Terminal sessions are identified by `terminal_id`, remain mounted while the user switches Herdr tabs and panes, and can be switched or closed independently. Input and resize events are routed to the exact terminal connection; metadata commands never share an interactive shell channel.

The renderer is responsible for ANSI color, alternate screen applications, cursor modes, bracketed paste, resize, selection, scrollback, clipboard, and mobile special keys. It does not interpret Herdr management state.

### Native Codex chat projection

Codex panes can expose two presentations of the same live process. The existing
Herdr terminal stream continues to feed the mounted xterm Terminal View. After
the user explicitly opens Chat, Whip uses the pane's Herdr `agent_session` ID to
resolve that exact Codex rollout over the existing authenticated SSH connection:

```text
Herdr terminal stream              Codex rollout JSONL
        |                                  |
        v                                  v
  Terminal View                      Codex adapter
                                            |
                                            v
                                normalized AgentChatItem[]
                                            |
                                            v
                                    Native Chat View
```

The transcript is lazy-loaded on first Chat use, normalized and cached only in
RAM, and followed while its associated terminal session remains open—even when
Terminal View is in front. The remote rollout remains authoritative; reconnects
rebuild normalized state from it. Whip does not persist complete transcripts,
infer identity from cwd/titles/timestamps, parse ANSI into messages, or create a
second Codex process. Chat composer submissions return to the same Herdr pane
and PTY used by the mounted terminal.

## React Native state ownership

- **Server profiles:** persistent metadata, keyed credentials, last-used state.
- **Live host sessions:** serializable per-host connection, snapshot, selection, sync generation, error, and reconnect state.
- **Runtime registry:** one non-serializable `HerdrClient`, refresh coordinator, status history, and reconnect timer per live host.
- **Herdr snapshots:** normalized workspaces, tabs, panes, agents, and server capabilities, isolated per live host.
- **Terminal sessions:** ordered open terminals plus active `terminal_id` per live host; terminal WebViews stay mounted across tab and host changes.
- **Virtual Herdr terminals:** in-memory cached ANSI snapshots and logical scroll state per terminal while its live transport is offline; xterm reports measured viewport geometry and remains responsible for rendering and gestures.
- **Navigation:** native destinations and sheets; terminal navigation is separate from Herdr workspace/tab focus.

Transport objects do not live in React component state. A service owns SSH/API lifetimes; React consumes serializable state and invokes typed actions.

## Mobile information architecture

### Servers

A Termius-style saved-server list is the entry surface. It shows identity, address, last connection result, and a primary connect action. Editing authentication is separate from operating a connected Herdr session.

### Herd

The attention surface can scope the queue to one live host or merge every live host. It orders agents by actionable status: blocked, done, working, idle, unknown, while preserving host, workspace, and pane context for terminal attachment and host-specific actions.

### Workspaces

Native workspace, tab, and pane navigation replaces the corresponding Herdr TUI chrome. Selection changes client navigation first; explicit focus actions change server focus. Closing a tab takes effect immediately, while other destructive operations require confirmation.

### Terminals

An immersive terminal surface keeps a slim scrollable session rail, connection status, close/new actions, and a horizontally scrollable mobile key rail. Switching back to Herd, Hosts, or More must not disconnect or recreate terminal sessions.

### Settings

Connection details, notifications, speech, terminal preferences, known hosts, diagnostics, and disconnect are device-local settings. Server-owned Herdr settings should be clearly distinguished from mobile preferences.

## Reliability rules

- Native activity launch is not proof that JavaScript rendered; visually inspect the expected screen.
- A stale control-plane connection must be visible and must not silently present old state as live.
- Reconnect attempts are serialized per server/terminal and use bounded backoff.
- After an event-stream gap or reconnect, fetch a fresh session snapshot before applying new events.
- Terminal frames are byte-stream ANSI data carried through the typed UniFFI/JSI path. Do not convert the hot path to JSON strings or reinterpret partial UTF-8 before xterm receives the bytes.
- Keep control and terminal failures independent. One failed terminal must not disconnect the Herdr dashboard or other terminals.
- Backgrounding may suspend polling/rendering, but it must not imply that the remote Herdr session stopped.

## Current implementation

Implemented:

- concurrent remote SSH control connections with an active-session selector;
- structured Herdr snapshots and native management screens;
- independent client-socket terminal controller per opened pane;
- persistent Hosts, Herd, Terminal, and More navigation adapted to Android and iOS conventions;
- a live-host rail plus nested Herdr workspace/tab/pane navigation;
- multiple mounted, switchable terminal sessions per host with bounded reconnect backoff and same-host restoration;
- lazy native Codex Chat projection from exact Herdr session identity and remote rollout JSONL, with RAM-only caching and live following;
- serialized snapshot refresh, stale-response rejection, event resubscription, and bounded control reconnect without tearing down healthy terminal clients;
- typed binary terminal frames through UniFFI/JSI, batched at the WebView boundary;
- terminal search, clipboard and OSC 52 writes, selection handles, long-press selection/paste, remote viewport swipes, and configurable gestures;
- mobile extra keys with one-shot and long-press-locked Ctrl/Alt modifiers;
- persisted terminal font, scrollback, cursor, notification, speech, language, appearance, security, and navigation preferences;
- multiple saved host profiles with platform-protected credentials and last-used ordering;
- strict host-key verification, nested jump hosts, restricted agent forwarding, and SSH-backed private-network browser tunnels;
- SFTP browsing, transfer, editing, deletion, and previews for text, code, Markdown, images, SVG, Mermaid, PDF, audio, video, and sandboxed HTML;
- shared Rust/Russh SSH behavior on Android and iOS through UniFFI, with typed binary terminal frames on the hot path;
- Android release signing/Play delivery and unsigned ARM64 iOS device artifacts.

Current transport/product milestones:

1. Signed iOS beta/release distribution.
2. Compatibility work for newly released Herdr protocols beyond 20.
3. Terminal release semantics and restoration across mobile process death.
4. Broader accessibility, large-screen, keyboard, and device coverage.
5. More Herdr-native mobile actions that do not reproduce the management TUI.
