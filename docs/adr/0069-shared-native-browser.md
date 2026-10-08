# 0069: Agents drive the desktop's native browser

Date: 2026-10-07. Status: accepted. Amends [ADR 0055](0055-browser-backends.md) and
[ADR 0067](0067-browser-parity.md).

## Context

ADR 0067 sent every agent browser session to the daemon's headless Chromium, even with the
desktop connected, and the person watched a JPEG screencast of it. That is slow to look at,
lags the agent, and a takeover drives a picture of a page rather than the page. The desktop
already hosts the thread's page natively (ADR 0055): a `WebContentsView` whose CDP is relayed
to the daemon from Electron's in-process `webContents.debugger`. The person and the agent should
use that one page.

## Decision

**One backend choice for people and agents.** `background` (agent work) no longer forces
headless. A pure rule (`backendCandidates`) picks backends for a new session: `auto` tries
the registered desktop first and continues in headless Chromium if the desktop cannot open
the view (no window, its eight-view limit, an open error). `embedded` never falls back;
`headless` never uses the desktop. An open never replaces the thread's existing session:
an agent joins the page the person opened, whatever backend it runs on. Every agent tool
(navigate, input, snapshot, screenshot, approved evaluate, downloads, dialogs, tabs,
interaction measurement) already goes through `BrowserBackendSession`, so the embedded
session serves all of them through the existing relay. No remote debugging port is opened.

**The person sees the agent's page natively.** When the thread's Browser panel shows the page,
the view is drawn in the panel and the agent's input lands in it live. Takeover and handback
change the existing controller lease (ADR 0009 fencing, generation checks before dispatch);
the page is not reloaded or moved, so taking over is a lease round trip.

**Unseen views keep rendering while an agent drives them.** Chromium produces no frames for a
hidden view: screenshots and `requestAnimationFrame` stall. While the agent holds the lease and
has driven the view within 30 seconds, a view no panel shows is _parked_: moved, visible, into
one hidden, never-focused desktop window. Idle views stop rendering and are throttled as before.
A view the person drives is never parked; it renders only where they see it. The parking
window is destroyed with the last view, so it never keeps the app from quitting.

**Isolation.** `browser.profile` (`persistent` | `ephemeral`, layered, default `persistent`)
fills an open that names no profile. A persistent thread browser has its own partition
(`persist:ace-browser-<sha256(workspace:thread)>`) on the desktop and its own profile
directory for headless; threads never share cookies or storage, and the person's own
browser profile is never used. `ephemeral` is the private, in-memory mode: a cleared pooled
partition on the desktop, a temporary profile for headless. Electron keeps one `Session` per
persistent partition opened during the app's lifetime.

**Deletion.** Deleting a thread closes its browser and removes its headless profile. The desktop
purge is a new session-less relay operation, `purge {threadId, workspaceId}`: the desktop
closes any view of that thread, clears the partition's data and removes its directory; a
partition it never created is left alone. Deletions are recorded in
`browser_forget_pending` and retried each time a desktop registers until the desktop
confirms, so a deletion made while the desktop is closed is still honoured.
Startup reconciles pending cleanup with stored deleted threads to recover a crash between
deletion and cleanup recording. Purging is idempotent, so this can repeat confirmed purges
after restart. Live deletion and replay share serial admission to the desktop relay; replay
drains every batch, and a registration during replay requests another pass. A desktop
without partition purge support reports failure and leaves cleanup pending.

**Fallback and handoff.**

- No desktop (web or phone clients only, the window closed, the app not running): agent sessions
  open headless, as before. Each agent session is its own context; several run in parallel.
- Desktop lost mid-task: the session pauses (`browser.backendLoss`, default `pause`). The agent's
  next browser tool resumes it headlessly at the last URL (page state lost, reported as
  `pageStateLost`), unless a person holds the page; their ownership keeps it paused until
  they act. `browser.backendLoss: headless` still recovers immediately.
- Desktop arrives while an agent's headless session is open: the session **stays headless and
  is shown** through the screencast, with its cookies, sign-ins, history and JS state intact.
  Re-navigating in a native view would lose that state mid-task. The next session for the
  thread (after the browser is closed) opens natively.

## Measurements

`apps/desktop/e2e/browser-latency.e2e.ts` (non-gating; `ACE_E2E_ELECTRON=1
ACE_BENCH_BROWSER=1`) times agent navigation, an agent click until the person can see it, and
takeover, for both backends, against a local fixture. Numbers are recorded in the PR; they
are wall-clock on one machine and never asserted.

## Verification and limits

Pure tests cover the backend choice, resume rule and view presence decision. Process tests run
the real daemon, MCP endpoint and desktop backend over fake views: agent tools route to the
native view, headless fallback without a desktop, a later desktop keeping the headless page,
resume after desktop loss, and purge now or on the next registration. Desktop unit tests cover
command routing, closed views and purge. The desktop e2e drives an agent navigation and click
visible in the native view, an instant takeover on the same page, and a screenshot of an
unseen parked view. Parking was verified on macOS only; other platforms' occlusion handling of
a never-shown window is not yet verified.
