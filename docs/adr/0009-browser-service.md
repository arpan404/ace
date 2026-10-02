# 0009: Daemon-owned browser sessions for every client

Date: 2026-10-02. Status: accepted.

## Context

The competitor inventories at `/tmp/ace-orch/research-t3code.md` and
`/tmp/ace-orch/research-competitors.md` describe browser automation, workspace
profiles, site approvals, console files and action recordings. t3code's embedded
browser view is desktop-only. Cursor exposes browser tools through MCP; Codex and
Claude have app previews and Chrome integrations; Antigravity saves screenshots
and videos as artifacts. ace needs the same browser session to be visible and
controllable from a phone or web client connected to the user's daemon.

These inventories establish requirements only. Implementation is written fresh
from [Playwright's browser API](https://playwright.dev/docs/api/class-browsertype),
[browser installation documentation](https://playwright.dev/docs/browsers), and
the CDP [Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/),
[Accessibility](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/),
[DOM](https://chromedevtools.github.io/devtools-protocol/tot/DOM/) and
[Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/) domains.

## Decision

`@ace/browser` owns one Chromium process and one primary page per thread. It uses
`playwright-core`, detects an installed Chrome/Chromium, and offers an explicit
on-demand Playwright install into the daemon data directory. Browser startup is
lazy and headless by default. A headed session opens on the daemon host.
Persistent profiles belong to workspaces, are separate from the user's personal
Chrome profile, and have an exclusive lease. Concurrent threads cannot open the
same persistent profile. Ephemeral sessions use temporary profiles removed on
close. A bounded session registry rejects excess sessions instead of evicting
active work. The daemon closes all owned sessions at shutdown.

The public agent API is `execute(threadId, command)`: navigate, click, type,
press, scroll, snapshot, screenshot, evaluate, wait_for, logs, resize and emulate.
The MCP workstream can call this API without importing implementation files.
Commands are schema-validated, timed and serialized per session with a bounded
pending count. Take-over changes ownership immediately and interrupts pending
agent input by checking ownership again at dispatch. In-flight actions may finish;
take-over does not undo an already-dispatched click. Human input identifies the
controlling connection; disconnect hands ownership back to the agent.

Snapshots use CDP's accessibility tree and backend DOM ids. Refs include a
document generation and backend id: an existing element keeps its ref across
snapshots and unrelated DOM edits, while navigation invalidates old refs. Only
the most recent bounded snapshot grants actionable refs. Resolution uses
`DOM.resolveNode` with short-lived CDP object handles; refs never become selectors
or page-provided code. Accessibility output has node and byte caps; oversized
documents fail before fetching a full AX tree. Screenshots are written as artifacts rather than sent as
unbounded JSON. Evaluate is denied unless an injected policy explicitly allows
it, independently of site approval.

## Protocol and wire additions

A new schema-only `packages/protocol/src/browser.ts` defines browser commands,
state, frames, controller events, client input and recording artifacts. Browser
wire requests use a separate `browser.*` union so existing command/event schemas
remain unchanged. Authenticated daemon sockets dispatch it through a small
browser bridge. Browser state and controller events are connection-scoped;
transient JPEG frames bypass the durable event log. Reconnecting clients receive
current state and the newest frame. Remote transport and relay implementations
can use the bridge through an authenticated connection interface without taking
ownership of Chromium or exposing CDP.

Clients acknowledge a frame after consuming it. Each subscription holds at most
one in-flight frame and one replaceable latest frame. Socket pressure prevents
sending; newer frames replace the pending frame. CDP frames are acknowledged
immediately even if subscribers are slow. FPS throttling and bounded JPEG
dimensions limit work; pressure lowers capture quality and frame rate. Fan-out
is O(subscribers), with a fixed subscription cap and no history scan. All viewers
share one frame serialization, which is collected when the frame is no longer used.

Recordings stream JPEGs and timestamps to disk with at most one write in flight.
Disk backpressure drops frames. Stop asks ffmpeg, when installed, to encode the
sequence with its original frame timing. A pipe watchdog kills the encoder if
the daemon dies. The streamed JSONL manifest and HTML player remain a fallback
when ffmpeg is absent or fails. The player also streams its manifest. Recording
size is capped. Completion returns an artifact and invokes an injected artifact
sink; the daemon appends an artifact item to the owning thread. A durable thread
item references the recording path and MIME type, not its bytes.
Artifact items may omit an agent owner before a thread's first provider run.

## Security and lifecycle

Only authenticated daemon connections may use the bridge. Paired devices need
read scope for frames and inspection and operate scope for browser actions.
Pinned WSS uses the same bridge; device revocation disconnects its controller. Human ownership is
bound to the connection, so another device cannot inject input or hand back its
session. Navigation and every intercepted HTTP request, including redirects and
subresources, pass an origin policy. CDP Fetch interception attaches to the primary
page and to isolated iframe and worker targets; Playwright routing alone skips
redirect hops. Targets, outstanding policy checks and CDP commands have caps.
Exact loopback hosts are allowed; other
origins default to deny and use an injected approval hook. WebSockets get the
same check. Non-HTTP navigation, personal profiles, exposed debugging ports and
automatic downloads are excluded. Service workers are blocked to prevent them
from bypassing request interception. Site approval results are not cached here;
the future interaction service owns approval lifetime and revocation. Hook calls
have a ten-second caller deadline and cancel on thread close or service shutdown.
One service-wide admission gate caps unsettled hooks at 32 across every entry
point, including WebSocket routing and evaluate. Excess requests fail closed
before invoking the hook or installing timers/listeners. Hooks receive the
thread's abort signal. Uncooperative hooks retain their slot until settlement,
even after caller cancellation, preventing retries from accumulating work.

Profiles, logs, screenshots and recordings may contain sensitive page data.
They stay under the user's daemon data directory with private directories.
Logs omit request headers and bodies, use bounded lines, and stop at a byte cap.
The service observes page errors and request completion without buffering bodies.
Close detaches capture and closes the context before awaiting the screencast-stop
reply, so a delayed CDP response cannot prevent process shutdown. It releases
CDP, encoders, streams, contexts and profile leases. Playwright
owns the process transport and kills children when its parent exits; explicit
shutdown awaits context closure. Unexpected browser exit removes the registry
entry and publishes closed state. Browsers cannot survive daemon restart.

## Testing and performance

Real Chromium and a local HTTP server test action results, stable and stale refs,
site policy, console/network log files, frame delivery to two clients, ownership,
recordings and process cleanup. Tests synchronize on observable events, not
sleeps or elapsed-time assertions. They skip with an explicit reason if Chromium
is unavailable. CI installs Playwright Chromium when running browser tests.
Pure fan-out tests exercise delayed acknowledgements and latest-frame replacement.
The capture shell accepts an injected clock. Launcher and process-spawner
boundaries are injectable for host integration and real-process tests. Keyboard
translation is pure and supplies validated CDP virtual key codes. Evaluation's
256 KiB result cap counts UTF-8 bytes inside Chromium before returning data.
Subscription registration rolls back when its initial state callback throws.
Regression tests cover delayed visibility and timeout rejection, oversized DOMs,
command saturation, sustained approval floods and per-thread cancellation.
Capture adaptation is checked through real JPEG quantization coefficients and
delivered frame timestamps, including recovery when pressure clears. Non-gating benchmarks measure frame
fan-out, validation/serialization, recording writes and log ingestion, including
RSS. Before delivery, at least eight production mutations
must each make a behavior test fail, then be reverted. Vitest runs one worker
to bound real browser, CLI, TLS and notification fixture processes on shared hosts.
Fixture deadlock ceilings are 60 seconds, or 120 for the profile test's three
process lifetimes; tests synchronize on events and assert behavior, without
elapsed-time performance assertions.

## Consequences

There is no Electron dependency and remote clients need no local browser engine.
Persistent workspace profiles cannot be used simultaneously by two threads.
This first version controls the primary page only; popup pages close immediately.
Browser approvals remain a hook until ace interactions land. Frame acknowledgements
are required in clients, and screenshots/recordings need artifact retrieval through
the daemon's file transport. Live frames are lossy by design; durable thread state
and artifact references remain reliable.
