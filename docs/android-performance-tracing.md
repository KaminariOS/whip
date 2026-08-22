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

- `Whip terminal input to native dispatch`: React Native handling through creation
  of the Rust/SSH write promise. This is local app overhead and does not await the
  transport operation.
- `Whip terminal input to first frame`: input handling until the first SSH terminal
  output reaches React Native. This contains transport RTT and remote processing.
- `Whip terminal frame to visible`: React Native frame handling, WebView injection,
  xterm parsing, and two animation-frame boundaries.
- `Whip terminal input to visible`: the complete measured user-visible path.

In the Perfetto SQL editor, load
`scripts/analyze-android-perfetto.sql` for completed sample counts, timeout counts,
and average/min/max values. Ten-second timeout sentinel slices are not included in
the latency statistics. The capture also includes Android FrameTimeline data for
checking missed application and SurfaceFlinger frames around slow samples.
If the local write and frame-to-visible slices are each around one display frame
or less while input-to-first-frame is near the measured 70–150 ms host RTT, the
network dominates. If either local slice is repeatedly tens of milliseconds,
inspect its JS, WebView, CPU scheduling, and frame-timeline tracks before treating
the app cost as negligible.

The terminal protocol cannot identify which PTY output byte was caused by a
specific input byte. The trace therefore pairs each input with the first subsequent
terminal frame. Capture on an otherwise idle terminal for an accurate interaction
measurement; unsolicited agent output can end a slice early.
