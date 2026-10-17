# 0083: The daemon owns one Chrome for every thread

Date: 2026-10-17. Status: accepted, revised the same day (see Hybrid). Amends
[ADR 0055](0055-browser-backends.md), [ADR 0069](0069-shared-native-browser.md),
[ADR 0009](0009-browser-service.md), [ADR 0054](0054-desktop-shell.md),
[ADR 0067](0067-browser-parity.md) and [ADR 0082](0082-browser-annotation.md).

## Context

The owner wants the Browser to behave like a real browser: agents use several tabs at once with
the full MCP toolset, agent browsing survives closing the thread or the window, and Chrome
extensions work. The browser that shipped before this decision could not get there:

- Every path was cut to one page (plus a short-lived sign-in popup). One command queue per thread
  switched the shared active tab, so two agents on two tabs would fight.
- The headless path ran one Chromium per thread through Playwright's `launchPersistentContext`.
  The CDP Extensions domain needs `--remote-debugging-pipe` and
  `--enable-unsafe-extension-debugging`, which Playwright does not expose.
- Every http(s) request, subresources included, was paused with CDP Fetch and decided in the
  daemon, although no origin policy is configured in the daemon. Each request waited on the
  daemon's event loop, which stalls for seconds under load. Service workers were blocked, which
  breaks sites and every MV3 extension.
- The desktop's native view dropped all pages when its window closed, and its placement and focus
  code produced the ~10 px offset and the lost first keystroke in the address bar.

## Decision

### Hybrid (owner revision, 2026-10-17)

The owner wants the in-app browser at the display's refresh rate (120 Hz). Headless Chrome on
macOS is locked to 60 Hz and the CDP screencast caps at 100 fps, so the first version of this
decision (one daemon Chrome as the only renderer) is revised:

1. **The desktop's native Electron view stays the primary renderer** (ADRs 0055 and 0069 are
   amended, not superseded). Its lifecycle is fixed in a later phase: views survive window close
   and thread switches, and the desktop app stays alive while threads have tabs or working agents.
2. **ace's own Chrome (below) is the background and fallback engine**: used when no desktop is
   attached, so agents keep working, and for web and phone clients through the screencast. A page
   moves between engines only when the desktop is genuinely gone.
3. **"Use my Chrome"**, an ace extension plus native messaging host that lets agents claim and
   drive tabs in the person's real browser, comes later as a third backend.

The tab model below is therefore backend-agnostic: every backend reports a tab list and the tab
the person is shown, and a backend that can hand out a page per tab (`tabs.page(tabId)`) gets
concurrent tabs. A backend that still holds one tab keeps working: opening a tab reuses its page.

### Engine

The daemon launches **Chrome for Testing** (the pinned 153.0.8010.12 build, downloaded and
verified on first use by the acquisition described in ADR 0055, which this ADR keeps) as
`--headless=new --remote-debugging-pipe`, and speaks CDP to it with its own client
(`cdp-connection.ts` over `pipe-transport.ts`). No Playwright. Its screencast is the render path
for web and phone clients, and for the desktop only while no native view is available.

Rejected:

- **Electron's extension support**: unpacked only, no Web Store, partial APIs, no action popups.
- **A hidden headful window**: native pickers, prompts and permission bubbles would be invisible.
- **The person's own Chrome**: Chrome 137 dropped `--load-extension` from branded builds and
  Chrome 136 refuses remote debugging of the default profile. ace never drives a person's profile.

### Owner decisions

- **One shared, persistent ace profile** (`<dataDir>/browser/profile`) for all threads:
  extensions and sign-ins are shared. A thread may opt into a private throwaway context
  (`profile: "ephemeral"`, a `Target.createBrowserContext` context in the same browser). This
  replaces "threads never share cookies" from ADRs 0067 and 0069. Deleting a thread no longer
  removes a profile.
- **Import extensions from Chrome** copies extension code only, never cookies, passwords or
  `Local Extension Settings`.
- **Agents may list extensions** and nothing more: no triggering extension actions, no cookie or
  storage tools.

### Process

`ChromeHost` (one per profile) starts Chrome on the first session lease with:
`--headless=new --remote-debugging-pipe --enable-unsafe-extension-debugging
--user-data-dir=<profile> --no-first-run --no-default-browser-check --no-startup-window
--disable-background-timer-throttling --disable-renderer-backgrounding
--disable-backgrounding-occluded-windows`, plus `--use-mock-keychain` on macOS,
`--password-store=basic` on Linux and `--force-device-scale-factor` (below). The command line is
a pure function (`chrome-flags.ts`). Nothing listens on TCP and no `DevToolsActivePort` is
written; tests check both.

- **Pipe.** fd 3 carries commands, fd 4 replies and events, NUL-delimited JSON. A frame may be up
  to 256 MiB. A broken pipe kills the process.
- **Commands.** Flattened target sessions. Unsettled commands are bounded by `CommandSlots`
  (256 in flight, 4096 waiting). Every command has a deadline (60 s by default) and an optional
  abort signal. A timed-out command fails alone, then a 5 s `Browser.getVersion` ping tells a slow
  page from a wedged browser; only a failed ping kills the process. The spike found one command
  (`Extensions.triggerAction` on a context without the extension) that never replies and stalls
  the whole pipe, so this is not hypothetical.
- **Targets.** Browser-level auto-attach for pages with `waitForDebuggerOnStart`: every page,
  including popups, starts paused, its owner installs listeners, the request guard and emulation,
  then lets it run. A created tab's attach event arrives before `Target.createTarget` replies; an
  unclaimed page waits 5 s for its creator and is otherwise closed. Popups are routed by
  `openerId`.
- **Process guardian.** The existing process guardian watches each launch and kills the
  profile's process groups if the daemon dies. A profile has one Chrome at a time: a restart
  waits for the previous process, and its guardian, to finish exiting.
- **Idle exit.** With no sessions the browser exits after 10 minutes. Service shutdown sends
  `Browser.close` and kills the process group at the cleanup deadline (5 s).
- **Renderer crash.** `Inspector.targetCrashed` on a tab: the same target is navigated to its last
  URL (a browser-side command, so it does not wait on the dead renderer), then capture and
  annotation are re-armed through the session's `restarted` hook. Page state is lost.
- **Browser crash or wedge.** Each session holding the dead browser takes a lease on a new one,
  recreates its main tab with the **same tab id** at its last URL and re-arms capture. Cookies
  survive in the profile; DOM, script and history state do not. In-flight commands fail. A
  session that cannot restart is reported lost.

Downloads land by GUID in `<profile>-downloads` (Chrome's `allowAndName`) and then pass through
the existing consent, privacy and quarantine pipeline into the session's artifact directory.

### Request policy

The request guard pauses only document requests (top-level and frame navigations, and each of
their redirect hops) and `file:` URLs. Navigation policy and the person/agent initiator still
see every document load; ordinary http(s) subresources, fetches, WebSockets and worker traffic
go straight to the network. Scheme checks stay: non-web URLs never load. Service and shared
workers run (they are released from the guard instead of being closed), which MV3 extensions and
many sites need. An embedder's origin hook now governs documents, not subresources.

### Display density

The spike showed that per-tab `Emulation.setDeviceMetricsOverride` with a device scale of 2 does
not raise screencast resolution; only the process-wide `--force-device-scale-factor` gives 2x
frames (2560 px wide, about 414 KB per frame at quality 80). The device scale is therefore a
launch setting, `chrome.deviceScaleFactor`, default **2** on every platform. That keeps the
headless output the browser produced before this change, gives Retina viewers sharp frames, and
costs little elsewhere: capture settings cap frame dimensions per viewer and model screenshots
are downscaled anyway. The daemon may run with no display attached, so it does not probe one.
Phase 3 revisits this with measured per-viewer frame sizes.

### Tabs

A thread's browser holds ordered tabs on whichever backend serves it.

- **TabRuntime** per tab (`tab-runtime.ts`): its own page surface, command queue (32 pending,
  128 across a thread), element refs, annotate mode, control lease (shared or private takeover is
  per tab) and lifecycle. Commands on different tabs run concurrently; a dialog holds only its own
  tab. Logs and downloads stay thread-wide and carry the tab id.
- **Routing** (`session-tabs.ts`): an explicit `tabId`, else the calling agent's own tab (its
  cursor, keyed by the MCP scope's `agentId`: the last tab it opened or selected), else the tab
  the person views. An identified agent whose fallback would land on another agent's tab gets a
  tab of its own. Only open, close and select take a short per-thread lock.
- **The person's view** is the backend's active tab. Agent commands, screenshots included, never
  move it. An agent's opened or selected tab takes the view only while the person has not picked
  a tab and is not holding the viewed one. Live capture and recording follow the viewed tab;
  frames carry `tabId`.
- **Tabs** report `openedBy`, `drivenBy`, `label`, `lease`, `lifecycle` and `loading`.
- **Limits**: 16 tabs per thread (popups included), 8 open per agent, 48 live across the daemon.
- **Lifecycle** (`tab-lifecycle.ts`, pure, injected clock): an unviewed, idle, unpinned tab
  freezes after 15 minutes (`Page.setWebLifecycleState`) and wakes before its next command. The
  policy also marks tabs due for discard after 2 hours; this is not applied yet, so page state is
  never dropped behind an agent's back. Freezing runs only in ace's Chrome.
- **Restore**: tabs are kept in the daemon's SQLite `browser_tabs` table (thread, tab id,
  position, URL, title, label, opener, last activity) behind the `BrowserTabStore` port. A
  restarted daemon reopens them lazily, on the first viewer or tool call, with the same tab ids;
  cookies survive in the profile. Closing the browser clears the records. Each tab is its own
  top-level target in its own window with focus emulation: background tabs in a shared window
  render no frames. A tab's CDP surface (`TabCdp`) survives browser restarts.

Not yet built: eager restore for threads with a working agent, discarding, the sleep/wake
browser ping, and per-viewer capture of different tabs.

## Spike evidence

macOS arm64, Chrome for Testing 153.0.8010.12, scripts outside the repo.

- 191 MB download, 359 MB unpacked. Pipe launch to first CDP reply: 349 ms. No TCP port, no
  `DevToolsActivePort`.
- `Extensions.loadUnpacked` takes about 3 ms; the id is stable through a manifest `key`; MV3
  service worker, content script and `storage.local` persist. Extensions loaded over CDP are not
  remembered across restarts, so ace reloads its own unpacked extensions on every start.
- `Extensions.triggerAction` works only with the `tab` target id; the popup page target appears
  about 100 ms later, is screencastable, takes CDP input and closes with `Target.closeTarget`.
- The Web Store's "Add to Chrome" does not work headless. Downloading the public CRX from
  Google's update endpoint, taking its public key as the manifest `key` and loading it unpacked
  gives the store id (uBlock Origin Lite worked and blocked ads). ace must verify and update
  those CRXs itself.
- In a `createBrowserContext` context, extensions run only if loaded with
  `enableInIncognito: true`; `triggerAction` where the extension is not enabled never replies.
- Real Metal GPU by default: WebGL 1/2 and WebGPU.
- Screencast at 1280×800, quality 80: 60 fps, p95 frame gap 17.5 ms, about 200 KB per frame.
  Key to frame latency over the local pipe: p50 7–9 ms, p95 about 10.5 ms.
- Native messaging under a custom user-data-dir reads only `<profile>/NativeMessagingHosts/`
  (1Password's signature check is untested). Linux, Windows and popup auto-close on blur are
  untested.

## Migration

Deleted in this phase: the Playwright launcher (`io.ts`), `headless-tabs.ts`, `chromium-close.ts`,
the `playwright-core` dependency of `@ace/browser` and its release runtime asset, per-thread
headless profile directories and their exclusive lease, and the recovery profile directories.
Tests that wrapped Playwright now use the `chrome` service option (`args`, `spawn`,
`intercept`) at the CDP wire.

The embedded backend is kept (see Hybrid). Annotation now lives per tab and is reinstalled
after a renderer crash; the overlay itself is unchanged.

## Relation to earlier ADRs

- **0055** (amended): the embedded/headless split and the desktop contract stay; the headless side
  is now ace's Chrome over a pipe, and the desktop relay gains `ace.tabs.open` with
  `{ background }`, answering with the tab list and `openedTabId`. Acquisition carries over.
- **0069** (amended): agents still drive the desktop's native view when it is attached, in several
  tabs; ace's Chrome shares one profile across threads instead of a profile each.
- **0009** (amended): one Chrome per profile instead of one Chromium per thread; no Playwright;
  only document requests are intercepted; service workers run.
- **0067** (amended): profile isolation per thread in ace's Chrome is replaced by the shared
  profile and private contexts; the eight-page context model is replaced by the tab model above.
- **0054** (amended): the embedded browser backend stays, with views that outlive their window.
- **0082** (amended): the overlay is reinstalled after a renderer crash in ace's Chrome as it was
  after `ace.rendererRestarted` on the desktop.

## Verification

Real-Chrome process tests run the existing browser suites (actions, parity, downloads, iframes,
annotation, lifecycle, capture adaptation) on the new backend against local HTTP fixtures, and
add: no debugging port and no `DevToolsActivePort`; a 1 MiB CDP message each way over the pipe;
a 300-image page whose only paused request is its document; a killed renderer brought back at its
last URL; a killed browser restarted with the thread's page reopened; a command with no reply
failing at its deadline while later commands run; a stopped (`SIGSTOP`) browser replaced; agent
key chords; the shared profile surviving a browser restart while a private context sees none of
it. Tab tests (`tabs.process.test.ts`, daemon `browser-tabs.process.test.ts`) drive real Chrome
with local fixtures: two agents typing in their own tabs at once, a slow tab not holding up
another, a screenshot of one tab leaving the view alone, a held or private tab blocking agents
only there, the per-agent and daemon limits, freeze and wake, MCP routing by tab id and cursor,
and a daemon restart restoring tab ids, labels and cookies through SQLite. CI installs the pinned Chrome for Testing with the same acquisition code and points the
suites at it.
