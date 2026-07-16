# Voltius Android to React Native port matrix

## Product goal

Herdr Remote should preserve Voltius's Android interaction model while replacing
generic SSH session management with Herdr-aware control surfaces:

```text
saved host
└── live host session
    └── Herdr workspace
        └── Herdr tab
            └── Herdr pane terminal
```

Herdr workspaces, tabs, panes, agents, status, and actions are native React
Native GUI. A pane's shell/TUI remains an xterm-compatible terminal.

## Current verdict

The app now ports Voltius's core Android session model to React Native while
replacing generic SSH navigation with Herdr workspaces, tabs, panes, agents,
and actions. It is not a full Voltius product port: the host-organization and
auxiliary remote-tool surfaces listed below are intentionally out of scope for
the current milestone.

## Port status

| Voltius Android concept | Herdr Remote status | Main references |
| --- | --- | --- |
| Saved hosts | Partial: add/edit/delete, per-host Keychain credentials, last-used ordering | `src/components/HostsScreen.tsx`, `src/services/hostProfiles.ts` |
| Concurrent live sessions across hosts | Implemented: each live host owns an independent client, snapshot, selection, terminals, refresh generation, and reconnect state | `App.tsx`, `src/liveHostSessions.ts` |
| Persistent terminal session rail | Implemented: outer host rail with select, close, status, terminal count, and new-session action | `src/components/LiveSessionRail.tsx` |
| Workspace → tab → pane hierarchy | Implemented: nested workspace/tab rails and pane switcher scoped to each live host | `src/components/SessionScreen.tsx` |
| Complete workspace/tab lifecycle | Implemented: create, focus, rename, and close actions, with post-command reconciliation | `src/components/SessionScreen.tsx`, `src/services/HerdrClient.ts` |
| Mounted terminal surfaces across navigation | Implemented per host and across host switching; hidden xterm WebViews retain state | `App.tsx`, `src/components/SessionScreen.tsx` |
| Terminal rendering | Implemented for the current bridge: atomic NDJSON frames, ANSI/color, mobile 82-column default, resize/redraw recovery, search, clipboard, gestures, and extra keys | `src/components/TerminalScreen.tsx`, `src/services/HerdrClient.ts`, `packages/react-native-ssh-sftp/` |
| Reconnect and connection overlays | Implemented: serialized refresh, stale-result rejection, bounded control reconnect, and independent terminal reconnect | `App.tsx`, `src/lib/refreshCoordinator.ts`, `src/lib/reconnectPolicy.ts` |
| Known-host verification | Missing and release-blocking | `packages/react-native-ssh-sftp/android/.../RNSshClientModule.java` |
| Host search, folders, pins, ping | Missing | Voltius `src/components/mobile/screens/MobileHostsScreen.tsx` |
| Snippets | Missing | Voltius `src/components/mobile/screens/MobileSnippetsScreen.tsx` |
| SFTP | Missing | Voltius `src/components/mobile/panels/MobileSftpScreen.tsx` |
| Port forwarding | Missing | Voltius `src/components/mobile/screens/MobilePortForwardingScreen.tsx` |
| Known hosts UI | Missing | Voltius `src/components/mobile/screens/MobileKnownHostsScreen.tsx` |
| Logs and diagnostics | Missing | Voltius `src/components/mobile/screens/MobileLogsScreen.tsx` |
| Remote tools (processes, metrics, Docker, Proxmox) | Missing | Voltius `src/components/mobile/panels/` |

## Implemented architecture

The singleton state in `App.tsx` has been replaced with two layers:

1. A serializable live-session store. Each session owns `hostId`, status,
   snapshot, selected workspace/tab/pane, terminal order, and reconnect state.
2. A runtime registry outside React state. Each live session owns its own
   `HerdrClient`, control connection, terminal connections, timers, and request
   generation.

The active session only controls which surface is visible. Switching hosts must
not disconnect or recreate other sessions.

## Remaining core work

1. Replace polling CLI calls with a persistent Herdr API stdio bridge and event
   subscription while keeping the per-host runtime boundary.
2. Add explicit terminal release semantics and stronger buffer restoration
   across process death.
3. Expand Herdr-native Android GUI for agent/TUI workflows rather than exposing
   Herdr management chrome through the terminal.
4. Add known-host verification before a production release.

Deferred by current product scope: host search/folders/pins/latency/actions,
snippets, SFTP, port forwarding, known-host management UI, logs, metrics,
processes, Docker, and Proxmox.

Do not add more global connection state to `App.tsx`; new features should land
on the per-session model so the singleton assumptions do not spread further.
