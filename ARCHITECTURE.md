# Whip architecture

## Product boundary

Whip is a remote client for a Herdr server running on another machine. It never starts a local Herdr runtime, local shell, or local PTY on the phone.

The app has two presentation modes:

- **Herdr control surfaces become Android GUI.** Workspaces, tabs, panes, settings, notifications, and connection state are React Native screens and sheets backed by structured Herdr state.
- **Pane terminals remain terminals.** When a user opens a shell or agent pane, the app attaches to that pane's terminal stream and renders its ANSI/TUI output faithfully in the terminal renderer.

The app must not render the full Herdr management TUI in a terminal and place Android controls around it. Herdr's TUI is one client presentation; Android is another client presentation over the same server-owned state.

## Three planes

### Transport plane

The phone reaches a remote machine over SSH. A saved server profile owns host, port, username, authentication reference, Herdr binary path, and named Herdr session.

Metadata may be stored in AsyncStorage. Passwords, private keys, and passphrases must be stored through Android Keystore and referenced by profile ID; they must never be embedded in profile JSON, logs, screenshots, or fixtures.

Production SSH requires known-host verification with explicit first-connect trust and changed-key rejection. The current native dependency disables `StrictHostKeyChecking`; this is a release blocker and must be replaced or patched before production use.

### Control plane

The control plane reads and mutates structured Herdr server state:

- server/version/capabilities
- session snapshot
- workspaces and worktrees
- tabs and panes
- agents, status, metadata, and recent output
- create, focus, rename, split, resize, send, close, and launch actions

The current vertical slice uses Herdr's JSON-producing CLI over SSH exec channels. This is acceptable as a compatibility transport, but repeated CLI polling is not the final protocol.

The target transport is one persistent newline-delimited JSON bridge to Herdr's local API socket over SSH stdio. It should support request IDs and `events.subscribe`, reconnect with backoff, refresh a snapshot after gaps, and expose neutral server concepts. It must not depend on private TUI layout or render messages.

If Herdr needs a new bridge command, it should be a neutral API/stdio bridge in Herdr, not an Android-specific endpoint and not a second source of runtime truth.

### Terminal plane

Each opened Herdr terminal owns an independent SSH exec channel and runs Herdr's client-protocol bridge:

```text
herdr [--session NAME] remote-client-bridge
```

The Android codec performs the binary `Hello` / `Welcome` handshake and then sends
`AttachTerminal` for the selected terminal. Herdr emits terminal frames and accepts
input, resize, scroll, and detach messages over that connection. Do not substitute
the human-facing `terminal attach` command: nesting that interface inside an SSH PTY
leaks shell chrome and breaks application-level input and resize behavior.

`TerminalAttach` is a direct pane connection. Its input bypasses Herdr's management
prefix router, so Android must expose workspace, tab, and pane operations as GUI
actions. Ctrl/Alt and control bytes in the terminal key rail belong to the program
inside the pane; they are not Herdr navigation shortcuts.

Terminal sessions are identified by `terminal_id`, remain mounted while the user switches Herdr tabs and panes, and can be switched or closed independently. Input and resize events are routed to the exact terminal connection; metadata commands never share an interactive shell channel.

The renderer is responsible for ANSI color, alternate screen applications, cursor modes, bracketed paste, resize, selection, scrollback, clipboard, and mobile special keys. It does not interpret Herdr management state.

## React Native state ownership

- **Server profiles:** persistent metadata, keyed credentials, last-used state.
- **Live host sessions:** serializable per-host connection, snapshot, selection, sync generation, error, and reconnect state.
- **Runtime registry:** one non-serializable `HerdrClient`, refresh coordinator, status history, and reconnect timer per live host.
- **Herdr snapshots:** normalized workspaces, tabs, panes, agents, and server capabilities, isolated per live host.
- **Terminal sessions:** ordered open terminals plus active `terminal_id` per live host; terminal WebViews stay mounted across tab and host changes.
- **Navigation:** native destinations and sheets; terminal navigation is separate from Herdr workspace/tab focus.

Transport objects do not live in React component state. A service owns SSH/API lifetimes; React consumes serializable state and invokes typed actions.

## Android information architecture

### Servers

A Termius-style saved-server list is the entry surface. It shows identity, address, last connection result, and a primary connect action. Editing authentication is separate from operating a connected Herdr session.

### Workspaces

Native workspace, tab, and pane navigation replaces the corresponding Herdr TUI chrome. Selection changes client navigation first; explicit focus actions change server focus. Closing a tab takes effect immediately, while other destructive operations require confirmation.

### Terminals

An immersive terminal surface keeps a slim scrollable session rail, connection status, close/new actions, and a horizontally scrollable mobile key rail. Switching back to Hosts or More must not disconnect or recreate terminal sessions.

### Settings

Connection details, notifications, speech, terminal preferences, known hosts, diagnostics, and disconnect are Android settings. Server-owned Herdr settings should be clearly distinguished from device-local preferences.

## Reliability rules

- Native activity launch is not proof that JavaScript rendered; visually inspect the expected screen.
- A stale control-plane connection must be visible and must not silently present old state as live.
- Reconnect attempts are serialized per server/terminal and use bounded backoff.
- After an event-stream gap or reconnect, fetch a fresh session snapshot before applying new events.
- Terminal bridge envelopes are newline-delimited JSON, but decoded frame payloads are byte-stream ANSI data. Preserve the base64 bytes until they reach xterm.
- Keep control and terminal failures independent. One failed terminal must not disconnect the Herdr dashboard or other terminals.
- Backgrounding may suspend polling/rendering, but it must not imply that the remote Herdr session stopped.

## Current vertical slice

Implemented:

- concurrent remote SSH control connections with an active-session selector;
- structured Herdr snapshot and native management screens;
- independent SSH/PTTY connection and Herdr bridge controller per opened terminal;
- Voltius-style persistent Hosts, Terminal, and More mobile shell with Android back handling;
- Voltius-style outer live-host rail plus nested Herdr workspace/tab/pane navigation;
- multiple mounted, switchable terminal sessions per host with bounded reconnect backoff and same-host restoration;
- serialized snapshot refresh, stale-response rejection, and bounded control-channel reconnect without tearing down terminal SSH clients;
- atomic Android line streaming for large Herdr NDJSON frames and a delayed PTY/controller redraw that makes fresh TUI attaches reliable;
- an 8px mobile terminal default (82 columns on the verified emulator) with migration from the old 11px default;
- terminal search, Android clipboard, OSC 52 writes, long-press word selection/paste, remote viewport swipes, and double-tap Tab;
- mobile extra keys with one-shot and long-press-locked Ctrl/Alt modifiers;
- persisted device terminal font, scrollback, cursor, notification, speech, and last-tab preferences;
- multiple saved server profiles with per-host Android Keystore credentials and last-used ordering;
- emulator, Metro, Expo MCP, and Argent debugging loop.

Next transport/product milestones:

1. Known-host verification and trust/change-key UI.
2. Persistent Herdr API stdio bridge with events and capability negotiation.
3. Terminal release semantics and restoration across Android process death.
4. More Herdr-native GUI for agent/TUI workflows.

Host organization and auxiliary Voltius surfaces are deferred for now; see the
explicit scope list in `VOLTIUS_PORT.md`.
