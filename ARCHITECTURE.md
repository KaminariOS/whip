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

Both platforms link one `whip-ssh` static library and expose one WhipSsh TurboModule. The Rust core loads one process-wide OpenSSH-compatible known-host repository, returns unknown keys for explicit fingerprint approval, and rejects changed keys. Direct hosts and every jump-host hop follow the same rule.

### Control plane

The control plane reads and mutates structured Herdr server state:

- server/version/capabilities
- session snapshot
- workspaces and worktrees
- tabs and panes
- agents, status, metadata, and recent output
- create, focus, rename, split, resize, send, close, and launch actions

Whip opens SSH stream-local channels directly to Herdr's local API socket. Short-lived request channels carry structured actions and snapshots; a persistent subscription channel carries events. The `whip-ssh` Rust core owns request IDs and JSON serialization, newline response framing, response/error validation, subscription serialization, incremental JSONL framing, event normalization, and conversion into typed domain events. Herdr calls an owned `SshSession` through ordinary Rust methods and closures; there is no C ABI, callback context, dynamic symbol lookup, or JSON dispatch between the SSH and Herdr modules. Herdr JSON does not cross the React Native boundary. Rust applies snapshots, events, and confirmed mutation results to one authoritative per-host domain model. TypeScript invokes semantic operations and renders a typed, versioned projection.

One Rust `HostRuntime` owns each connected host's authenticated `Arc<SshSession>`,
ProxyJump chain, control generation, reconnect loop, event subscription, and
Herdr terminal registry. Reconnect replaces the owned session, advances the
existing generation/epoch state, cancels stale work, and restores requested
resources without bouncing through JavaScript. Shell, command, remote-home,
latency, forwarding, SFTP, upload cancellation, and file-server operations all
use the runtime's owned session directly; no string-key session alias is
published for React Native.

`HostState` owns workspace/tab/pane topology, layouts, server focus, derived
agent status, snapshot sync generations, monotonic state revisions, and
freshness. Snapshot requests carry both connection and sync generations. Events
that arrive while a snapshot is in flight are applied immediately and buffered,
then replayed over the accepted snapshot so an older response cannot erase
already-observed changes. Herdr does not currently expose a single revision
shared by its request and subscription channels, so Rust coalesces a follow-up
snapshot after gaps or inconsistent references instead of hiding that ordering
limit with delays.

If Whip needs a new server capability, it should be a neutral Herdr socket API method or event, not a mobile-specific endpoint and not a second source of runtime truth.

Herdr's Unix API accepts one normal request and then closes that socket
connection; only subscriptions remain open. Control requests therefore use
separate short-lived stream-local channels. Do not treat the API socket itself
as a multiplexed transport.
A cold connection uses `ping` as the availability handshake and reads the
Herdr version and protocol from its `pong` response. Rust then takes a bootstrap
snapshot to obtain the current pane IDs, opens the complete lifecycle and
per-pane event subscription, waits for Herdr's `subscription_started`
acknowledgement, and takes a reconciliation snapshot while buffering events.
Whip caches each resolved absolute socket path for the life of the app process.
`HostRuntime` validates a cached path and re-resolves it through its current SSH
session if the cached path stops accepting channels. Rust selects the
protocol-specific terminal attach variant from the ping result.

### Terminal plane

Each opened Herdr terminal owns an independent SSH stream-local channel to the
server's client-protocol socket. The Whip Rust core owns protocol validation,
binary encoding/decoding, the `Hello` / `Welcome` / `AttachTerminal` state
machine, prepared connections, and protocol-level cleanup. Its Herdr bridge
opens and drives the length-prefixed channel directly on the owned Rust SSH
session; terminal frames do not travel through a JavaScript codec, generic JSON
event path, or a second native library. React Native sends
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

### Rust-owned agent transcripts

Codex panes can expose two presentations of the same live process. The existing
Herdr terminal stream continues to feed the mounted xterm Terminal View. After
the user explicitly opens Chat, the Rust `HostRuntime` uses the pane's Herdr
`agent_session` ID to open an `AgentSessionManager` entry and resolve that exact
Codex rollout over the existing authenticated SSH transport:

```text
Herdr terminal stream              Codex rollout JSONL
        |                                  |
        v                                  v
  Terminal View               Rust Codex source runtime
                                            |
                              framing / offsets / retry
                                            |
                                            v
                                typed AgentTranscript
                                            |
                                            v
                                    Native Chat View
```

Rust owns rollout identity, byte-oriented JSONL framing, partial lines,
received/committable/durable offsets, generation guards, source replacement and
truncation detection, catch-up, retry/rebind, and incremental normalization.
Each state projection has a monotonic revision and can be fetched in full, so a
missed callback does not lose transcript correctness. The remote rollout remains
authoritative. A versioned opaque Rust cache blob is stored by the existing
platform SQLite layer; Rust validates and replays it before resuming, and only
advances the durable checkpoint after the platform confirms the blob write.
Transient source failure retains known content as stale rather than replacing it
with an empty transcript.

`AgentTranscript` is agent-neutral typed domain state: messages, turns, text,
visible reasoning summaries, tools, plans, notices, file diffs, lifecycle status,
and stable source-derived IDs. React Native mechanically projects those records
into the existing render types and retains only UI concerns such as scrolling,
expansion, composition, markdown, and navigation. It does not know rollout paths,
offsets, JSONL records, or retry policy. OpenCode still uses its existing
TypeScript export/event adapter for now, but the Rust model and session-kind
boundary already include OpenCode so its persistence adapter can migrate without
changing the renderer. Chat composer submissions return to the same Herdr pane
and PTY used by the mounted terminal.

## React Native state ownership

- **Server profiles:** persistent metadata, keyed credentials, last-used state.
- **Live host render cache:** the latest monotonic Rust `HostState` projection per host plus mobile-only workspace selection and connection/latency presentation.
- **Runtime registry:** one thin non-serializable `HerdrClient` facade per live host. Its native `HostRuntime` owns transport identity, reconnect attempts, subscriptions, terminals, refresh coalescing, and authoritative domain state.
- **Herdr host state:** normalized workspaces, tabs, panes, layouts, agents, server focus, synchronization, and freshness are authoritative in Rust; React retains only the latest projection for rendering.
- **Codex transcript state:** one Rust `AgentSessionManager` per `HostRuntime` owns remote source identity, incremental parsing/checkpoints, reconnect rebind, and normalized revisioned chat state. React retains a typed render projection and opaque cache storage only.
- **Terminal sessions:** ordered open terminals plus active `terminal_id` per live host; terminal WebViews stay mounted across tab and host changes.
- **Virtual Herdr terminals:** in-memory cached ANSI snapshots and logical scroll state per terminal while its live transport is offline; xterm reports measured viewport geometry and remains responsible for rendering and gestures.
- **Navigation:** native destinations and sheets; terminal navigation is separate from Herdr workspace/tab focus.

Transport objects do not live in React component state. Rust owns SSH/API
lifetimes and connected-host domain truth; React consumes typed versioned state
and invokes semantic actions through the `HerdrClient` facade. Mobile workspace
selection, navigation, sheets, forms, persisted presentation preferences, and
terminal view state remain TypeScript concerns. Mobile selection never mutates
Herdr server focus locally.

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
- `HostRuntime` serializes reconnect attempts per host with bounded equal-jitter
  backoff, an explicit lifecycle state, monotonic epochs, and cancellation on
  user disconnect. A stale transport, event subscription, or terminal open may
  not replace a newer generation.
- During reconnect, retain known-good host state and mark it stale. Rust restarts
  the event subscription, performs a generation-guarded snapshot sync, and only
  marks the projection fresh after reconciliation. A failed read never becomes
  a successful empty snapshot.
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
- multiple mounted, switchable terminal sessions per host with Rust-owned bounded reconnect and same-host restoration using the last native geometry;
- Rust-owned Codex Chat sessions from exact Herdr session identity and remote rollout JSONL, with incremental parsing, durable opaque checkpoints, typed normalized projections, source-generation guards, and reconnect-safe live following;
- Rust-owned snapshot/event reconciliation with in-flight event replay,
  generation-guarded stale-response rejection, monotonic projections, and
  coalesced repair syncs;
- typed binary terminal frames through UniFFI/JSI, batched at the WebView boundary;
- terminal search, clipboard and OSC 52 writes, selection handles, long-press selection/paste, remote viewport swipes, and configurable gestures;
- mobile extra keys with one-shot and long-press-locked Ctrl/Alt modifiers;
- persisted terminal font, scrollback, cursor, notification, speech, language, appearance, security, and navigation preferences;
- multiple saved host profiles with platform-protected credentials and last-used ordering;
- strict host-key verification, nested jump hosts, restricted agent forwarding, and SSH-backed private-network browser tunnels;
- SFTP browsing, transfer, editing, deletion, and previews for text, code, Markdown, images, SVG, Mermaid, PDF, audio, video, and sandboxed HTML;
- shared Rust/Russh SSH behavior on Android and iOS through UniFFI, with typed binary terminal frames on the hot path;
- native Herdr control request/response handling and typed event-stream framing, validation, and normalization shared by Android and iOS;
- a shared Android/iOS Rust `HostRuntime` with explicit connection states,
  generation guards, cancellable reconnect, event-stream restart, and terminal
  restoration plus authoritative workspace/tab/pane/layout/focus/agent state;
  React Native receives typed lifecycle and versioned state projections;
- Android release signing/Play delivery and unsigned ARM64 iOS device artifacts.

Current transport/product milestones:

1. Signed iOS beta/release distribution.
2. Compatibility work for newly released Herdr protocols beyond 20.
3. Terminal release semantics and restoration across mobile process death.
4. Broader accessibility, large-screen, keyboard, and device coverage.
5. More Herdr-native mobile actions that do not reproduce the management TUI.
