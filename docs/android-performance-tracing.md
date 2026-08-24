# Android terminal latency tracing

Whip emits correlated Android app async trace slices that Perfetto records only
while tracing is enabled. When Perfetto is inactive, each terminal input performs
one synchronous native `Trace.isEnabled()` check and creates no timers or slices.

Capture a trace with one authorized Android device connected:

```bash
nix develop -c scripts/capture-android-perfetto.sh 20
```

During the capture, type individual characters and submit several short commands
whose output is immediate (for example, `printf ok`). Open the resulting
`artifacts/perfetto/*.perfetto-trace` file in <https://ui.perfetto.dev>.

The app-defined slices divide perceived latency into these intervals:

Startup and application-work slices:

- `Whip startup to first tab`: storage hydration through the first selected tab's
  committed mount.
- `Whip startup storage hydration`: the five persisted stores required to leave
  the loading screen.
- `Whip startup restore live hosts`: reconnecting all persisted live hosts and
  restoring their snapshots and terminal state.
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

No markers are added inside the external `react-native-russh` dependency. The
owned outbound boundary is measured precisely; inbound FFI overhead remains part
of `native queue to response` because separating it would require a russh marker.

The terminal protocol cannot identify which PTY output byte was caused by a
specific input byte. The trace therefore pairs each input with the first subsequent
terminal frame. Capture on an otherwise idle terminal for an accurate interaction
measurement; unsolicited agent output can end a slice early.
