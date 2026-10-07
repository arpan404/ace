# Measuring interaction smoothness

Agents can call `screen_measure_interaction` for an approved macOS window session
or `ace_browser_measure_interaction` for a thread's browser tab. Both return a
compact JSON text part and, when requested, one JPEG filmstrip image part.
The daemon retains the structured result on the calling transcript step and stores
the JPEG filmstrip as a thread-owned attachment. No video or trace is written to disk.

```json
{
  "sessionId": "approved-window-session",
  "action": { "kind": "scroll", "dx": 0, "dy": -300 },
  "observeMs": 2000,
  "repeat": 1,
  "filmstrip": true
}
```

```json
{
  "tabId": "thread-tab",
  "interaction": { "action": "click", "ref": "snapshot-ref" },
  "observeMs": 2000,
  "repeat": 1,
  "filmstrip": true
}
```

Omit `action` or `interaction` to observe only. Observation requires approved
view access, Screen Recording for macOS, and no input controller or Accessibility
grant. Measured input uses the existing controller, app or site approval, secure
input consent, background routing and focus guard. The screen tool defaults to
background mode; it does not request foreground approval or change the cursor.
An explicit browser `tabId` uses the existing tab-selection controller and effect
approval; omit it to observe the current tab with view permission.
Browser measurements use ace-owned headless Chromium or the desktop embedded
backend's CDP connection. They never attach to a personal browser profile.
The native focus guard checks the existing short input-settle boundary. Human
cursor or focus changes later in the observation window do not invalidate input.

`observeMs` defaults to 2000 and accepts 1 through 10000. `repeat` accepts 1
through 5. Observation plus an explicit native drag duration must fit 10 seconds
per run and 20 seconds across repeats. Browser observation includes input
dispatch time. Native repeats count actual spans, including AX preparation, and
clip the final recording to the remaining allowance. Clipped evidence is
inconclusive. Every repeat performs the supplied action again. Repeats do not
reset the application, so use an interaction whose repeated effects are useful.
The worst run supplies the detailed gaps and filmstrip; `repeat.metrics` supplies
median and worst values and `repeat.runs` supplies each verdict and confidence.
Missing optional metrics are omitted rather than counted as zero. Worst means
minimum refresh rate or FPS and maximum for the remaining metrics.

`frames` counts observed content updates. `effectiveFps` and `droppedFrames` use
only active inter-update spans and exclude the trailing idle period. Hitches are
update gaps longer than 1.5 display intervals, with a maximum of twenty detailed
gaps. `hitchTimeMs` and `hitchRatioMsPerS` include all detected hitches even when
the list is capped. Hitch time is the gap minus one expected interval. The tool's
verdict thresholds are less than 5 ms/s for smooth, 5 through 10 for minor
hitches, and greater than 10 for janky. These are the requested tool thresholds;
they are estimates from observed updates rather than Apple's instrumented render
loop or perceptually adjusted MetricKit measurements. See Apple's
[render loop and hitch explanation](https://developer.apple.com/documentation/xcode/understanding-hitches-in-your-app).

Latency, settle, hitch offsets, long-task offsets and filmstrip labels are
relative to input dispatch, or capture start for observation. The before tile
may have a negative timestamp. `windowMs` is the full recorded span. Settle time
is returned only when the last observed change has at least 250 ms of stillness
before capture ends. Few updates produce an inconclusive smoothness verdict,
while zero updates produce `no_change`. Gaps of at least 250 ms can represent
intentional pauses or long stalls. Without a confirming browser long task,
they separate animation spans and lower confidence; they cannot prove smoothness.

The macOS helper captures the target window with ScreenCaptureKit at its
maximum display refresh, with queue depth three. Presentation timestamps and
injection marks use the same CMClock host clock. A 96 by 64 RGB grid detects
changes and prefers changes near the action point for latency. Tiny changes can
be missed, and deliberate animation below display rate can appear as hitches.
Baseline acquisition has a separate one-second timeout. An independent watchdog
stops recording at ten seconds even if input dispatch blocks; clipped evidence
returns an inconclusive verdict.
Only timing numbers and at most sixteen thumbnail candidates are retained. The
JPEG grid includes before, first response, representative frames, worst hitch
endpoints and settled content, with damage outlines. Its encoded size stays
within the existing 64 KiB native reply boundary.

Browser timing uses a bounded 4 MiB CDP trace, a private isolated-world clock
marker, compositor DrawFrame events, main-thread long tasks and layout shift
session scores. A host monotonic input offset starts before the trace marker's
CDP request. This conservatively excludes pre-input frames, but can miss an early
response during the marker's round trip. Refresh is inferred from BeginFrame
cadence and may be virtual in headless mode. Unknown cadence lowers confidence.
Compositor frames are matched to the target frame's renderer and layer tree;
long tasks can include contention from other tabs sharing that renderer.
Filmstrip images reuse the live screencast and illustrate timing; they do not
supply frame cadence. Browser traces are admitted one at a time because Tracing
is browser-wide. An overlapping measurement fails explicitly.

Confidence is low when the one-minute load exceeds logical core count, capture
callback processing exceeds ten percent of the span, refresh is assumed,
evidence is incomplete, or there are too few updates. Capture overhead excludes
WindowServer/GPU or Chromium instrumentation cost and post-window JPEG grid
encoding. Inspect the notes before treating a verdict as evidence of a fix.

The deterministic native fixture checks smooth versus a 120 ms injected stall
and a 180 ms delayed click response. Run the dedicated process test with
`ACE_SCREEN_INTEGRATION=1`; missing permissions or locked capture produces an
explicit skip and never opens a permission prompt. Non-gating overhead scripts
are `packages/screen/bench/interaction.ts` and
`packages/browser/bench/measurement.ts`. The native benchmark requires the same
explicit opt-in and uses only the worktree's fixture app.

## Transcript evidence

`tool_call.measurement` is daemon-owned `StepMeasurement` data. Its metrics match
`InteractionMeasurement`, while `filmstrip` is attachment metadata with a SHA-256
content id instead of base64 bytes. Clients read it with `attachment.read` or the
existing authenticated attachment HTTP path, on the connection owning the thread.
The smoothness card prefers this field and retains provider-payload reading for
older steps. Both screen and browser MCP tools use the same capture boundary.

MCP request ids are independent of provider tool ids. At call admission the daemon
binds a unique matching active canonical step using the live lease's thread,
creation sequence, tool name and canonicalized arguments. The binding keeps that
step's id through subsequent provider updates. Subagent steps share their root's
lease and remain owned by their canonical agent.

When call frames arrive after execution, the daemon considers matching steps
created since admission within a five-second delivery window. Multiple matches
remain uncorrelated. Ending the lease or starting another call with the same
arguments closes the older pending correlation. An uncorrelated result remains a
standalone `notice` with `code: "interaction_measurement"` and typed `measurement`;
a later unique match moves the evidence onto the step and deletes the fallback.
No result is dropped because the provider omitted a frame or retained only the call.

The indexed SQLite evidence survives restarts and restores the field when a
provider replaces its step payload. Attachment ownership prevents client release
while a live thread references the filmstrip. Thread deletion releases that
ownership through the existing attachment cleanup and crash reconciliation paths.
Native measurement replies allow 128 KiB to accommodate a 64 KiB JPEG's base64
expansion; ordinary helper replies retain their 64 KiB limit.
