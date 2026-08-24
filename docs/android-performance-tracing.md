# Android terminal latency tracing

Whip emits correlated Android app async trace slices that Perfetto records only
while tracing is enabled. When Perfetto is inactive, passive inbound frames do
only a JS timestamp/branch and probe native `Trace.isEnabled()` at most once per
second; they create no timers, cookies, or slices. Once a capture is detected,
every inbound frame is traced until the native trace probe reports disabled.

Capture a trace with one authorized Android device connected:

```bash
nix develop -c scripts/capture-android-perfetto.sh 20
```

For passive inbound tracing, start continuous output in a real or disposable
Herdr terminal and leave the phone untouched:

```bash
while true; do date +%s%3N; sleep 0.05; done
```

Open the resulting
`artifacts/perfetto/*.perfetto-trace` file in <https://ui.perfetto.dev>.

The app-defined slices divide perceived latency into these intervals:

Startup and application-work slices:

- `Whip startup to first tab`: storage hydration through the first selected tab's
  committed mount.
- `Whip startup storage hydration`: the shared multi-get plus host metadata and
  preferences required to leave the loading screen.
- `Whip startup store: multi-get`: the single AsyncStorage bridge call that
  fetches every startup key.
- `Whip startup store: <store>`: parsing or applying hosts, preferences, known
  hosts, live-host IDs, terminal history, credential status, or the versioned
  credential-backup migration. Noncritical stores begin after the first tab.
- `Whip startup restore live hosts`: reconnecting all persisted live hosts and
  restoring their snapshots and terminal state.
- `Whip startup restore: <stage>`: overlapping per-host credential, jump-host,
  SSH, initial-snapshot, terminal-state, event-stream, and reconciliation work;
  biometric approval is traced once when required.
- `Whip first tab mount: <tab>`: the first committed mount of each lazily loaded
  primary tab.
- `Whip host snapshot refresh`: a complete coordinated host snapshot request and
  application pass.
- `Whip transcript initial parse`: resolving, streaming, and normalizing the
  initial Codex rollout history.

Terminal interaction slices:

- `Whip terminal input to native dispatch`: React Native handling through creation
  of the Rust/SSH write promise. This is local app overhead and does not await the
  transport operation.
- `Whip terminal app pre-native wait`: app-owned terminal bridge readiness and JS
  scheduling between creation of the write promise and entry into native code.
  Retained bridges bypass the asynchronous readiness path.
- `Whip terminal native enqueue`: Whip's call through the JSI/UniFFI fast path,
  including Rust validation, length-prefix framing, and enqueueing the bytes for
  russh. It ends before russh performs the network write.
- `Whip terminal native queue to response`: time after the Rust queue accepts the
  input until the first terminal response reaches Whip's `HerdrClient`. This
  intentionally treats russh as a black box and therefore contains the russh
  write/read, network RTT, remote processing, inbound FFI callback, and private
  Herdr frame decoding.
- `Whip terminal native response to renderer`: Whip's synchronous delivery of the
  decoded frame from `HerdrClient` through the React Native renderer callback and
  WebView injection call.
- `Whip terminal input to first frame`: input handling until the first SSH terminal
  output reaches the renderer. This contains transport RTT and remote processing.
- `Whip terminal frame to visible`: React Native frame handling, WebView injection,
  xterm parsing, and two animation-frame boundaries.
- `Whip terminal input to visible`: the complete measured user-visible path.

Passive inbound terminal slices (these do not require an input event):

- `Whip terminal inbound Rust frame delivery`: starts immediately after Rust
  finishes a length-prefixed frame and includes synchronous event-sink delivery.
- `Whip terminal inbound native to JS`: the generated UniFFI C++ call around
  `invokeBlocking`; a spike here is direct evidence that the socket task is
  waiting for JS callback entry or synchronous JS callback work.
- `Whip terminal inbound JS receive`: an instant-sized marker at the first JS
  instruction reached by `unix_socket_channel_data`.
- `Whip terminal inbound JS decode`: event dispatch plus Herdr binary decode.
- `Whip terminal inbound renderer dispatch`: decoded frame delivery to
  `TerminalRendererHost`.
- `Whip terminal inbound WebView injection`: the synchronous
  `injectJavaScript()` call itself.
- `Whip terminal inbound WebView delivery`: injection start until React Native
  receives the WebView acknowledgement emitted on entry into `herdrWrite` or
  `herdrWriteBase64Chunk`. This includes WebView-to-RN message scheduling.
- `Whip terminal inbound xterm write`: the write-entry acknowledgement until
  React Native receives the acknowledgement emitted by `xterm.write`'s
  completion callback. This can also include RN callback scheduling.
- `Whip terminal inbound xterm to visible`: xterm completion through the two
  existing `requestAnimationFrame` boundaries.
- `Whip terminal inbound frame to visible`: the correlated end-to-end JS/WebView
  span. Its cookie is carried with the frame without copying terminal bytes.
- `Whip terminal resize: fit` and `Whip terminal resize: xterm`: count the two
  resize message sources so redundant fit/onResize cycles are visible.

The native callback marker is a documented diagnostic edit in generated
`packages/react-native-russh/cpp/generated/react_native_russh.cpp`, because the
current UniFFI generator exposes no callback wrapper/template hook. Regenerating
the binding must reapply the small `AndroidTraceSection` wrapper around method 1
(`unix_socket_channel_data`). It intentionally retains `invokeBlocking` and its
RustBuffer lifetime semantics.

For the debug-only render-drop A/B experiment, rebuild the debug app with:

```bash
EXPO_PUBLIC_WHIP_TERMINAL_RENDER_DROP=1 nix develop -c npm run android
```

This still receives and decodes terminal frames and crosses into the WebView,
but acknowledges the trace without calling `xterm.write()`. The switch is false
by default and is ignored in release builds. Rebuild without the variable for
normal rendering.

In the Perfetto SQL editor, load
`scripts/analyze-android-perfetto.sql` for completed sample counts, timeout counts,
and average/min/max values for both startup and terminal work. Ten-second timeout
sentinel slices are not included in the terminal latency statistics. The capture also includes Android FrameTimeline data for
checking missed application and SurfaceFlinger frames around slow samples.
If the local write and frame-to-visible slices are each around one display frame
or less while input-to-first-frame is near the measured 70–150 ms host RTT, the
network dominates. If either local slice is repeatedly tens of milliseconds,
inspect its JS, WebView, CPU scheduling, and frame-timeline tracks before treating
the app cost as negligible.

The passive diagnostic adds Android-only markers to the repository-owned
`react-native-russh` package at frame completion and at the generated callback
boundary. It does not change transport behavior or buffer ownership.

The terminal protocol cannot identify which PTY output byte was caused by a
specific input byte. The trace therefore pairs each input with the first subsequent
terminal frame. Capture on an otherwise idle terminal for an accurate interaction
measurement; unsolicited agent output can end a slice early.
