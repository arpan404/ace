# 0084: Use my Chrome

Date: 2026-10-17. Status: accepted. Amends [ADR 0083](0083-browser-v2-daemon-chrome.md) (its
rejection of "the person's own Chrome") and [ADR 0055](0055-browser-backends.md) (backend kinds).

## Context

Agents browse in ace's own browsers: the desktop's native view and ace's Chrome for Testing
(ADR 0083). Neither has the person's logins, extensions, password manager or corporate SSO. Some
work only makes sense in the browser the person already uses: a dashboard behind SSO, a staging
site that needs their VPN extension, a bug that only reproduces with their settings.

ADR 0083 rejected driving the person's Chrome because Chrome 136+ refuses remote debugging of
the default profile and branded Chrome 137+ ignores `--load-extension`. Both are deliberate
Chrome security decisions, and ace must not work around them. Chrome's supported path for a
local program to act on the person's tabs is an extension the person installs, talking to the
program through **native messaging**. Other desktop agents ship the same shape (an extension plus
a native host); we use that only as evidence that the shape is accepted by people and by Chrome,
and read none of their code.

## Decision

ace ships an MV3 extension, **ace for Chrome**, and a native messaging host. The person installs
both on purpose; together they give the daemon a third browser backend, kind **`user`**, that
works only on tabs the person allows. The settings label is "Use my Chrome". Agents select it
with `browser: "user"` on browser tool calls (see "Integration" below).

### Trust model

1. **Explicit opt-in, twice.** Nothing happens until the person (a) clicks Install in Settings ›
   Computer use › Use my Chrome, which writes the native host manifests, and (b) loads the
   extension themselves (`chrome://extensions` › Load unpacked, or later the Web Store). ace never
   writes into a browser's profile, `Preferences` or extension directories, and never launches the
   person's browser.
2. **Per-tab claim.** The extension acts on exactly two kinds of tabs:
   - **Shared** tabs: the person clicked "Share this tab with ace" in the extension's popup.
     Sharing is per tab and ends when the tab closes, the person un-shares, or they press Stop.
   - **Agent** tabs: tabs an agent opened through the extension. They live in a dedicated, unfocused
     **ace window** and inside a tab group titled "ace". Dragging one out of the window or group
     turns it into an ordinary tab of the person's and ends control. A tab that an agent tab's page
     opens (`target=_blank`, `window.open`) is an agent tab too: the extension groups and attaches
     it and reports its opener (`openerTabId`). Popups of the person's shared tabs stay theirs.
     Every other tab is invisible to the daemon: not listed, not attachable, no events.
3. **Visible indicator.** While the debugger is attached Chrome shows its own "ace for Chrome
   started debugging this browser" bar, which ace cannot hide. The toolbar icon shows a badge with
   the number of controlled tabs, and agent tabs carry the "ace" group label.
4. **Stop and revoke at any time.** The popup's Stop detaches every tab and forgets every share.
   Chrome's Cancel on the debugging bar, closing a tab, removing the extension, or quitting the
   browser all end control; the daemon reports the session lost and never retries on its own.
   Settings › Revoke deletes the host's credential (closing its socket), removes the manifests and
   tells connected browsers to stop.
5. **Sensitive pages.** The extension refuses to attach to, or navigate a controlled tab to,
   anything but `http:`, `https:` and `about:blank`. That excludes `chrome://`, `edge://`,
   `brave://`, `chrome-extension://` (password managers live there), `devtools://`, `view-source:`,
   `file:` and data/javascript URLs, plus a short host list: the Chrome Web Store and Google's
   password manager. A controlled tab that navigates (by any means) to a refused page is detached
   at once and reported as `sensitive`.
6. **No credential extraction.** CDP from the daemon passes an allowlist of domains (Page,
   Runtime, DOM, DOMSnapshot, CSS, Accessibility, Input, Emulation, Network, Log, Overlay) and a
   denylist inside them: every cookie method (`Network.getCookies`, `getAllCookies`, `setCookie(s)`,
   `deleteCookies`, `clearBrowserCookies`), `Network.setExtraHTTPHeaders`, and the whole `Storage`,
   `DOMStorage`, `IndexedDB`, `CacheStorage`, `Fetch`, `Target`, `Browser` and `SystemInfo`
   domains. The extension itself (never the daemon) sends `Target.setAutoAttach` with `flatten` on
   a controlled tab, from ace's first command there, to reach its out-of-process iframes; it relays
   only `iframe` child sessions and accepts commands only for those, under the same allowlist.
   ace has no cookie, password, storage or history tool for this backend. Page script an
   agent evaluates can still read what the page itself can (for example non-HttpOnly cookies) on a
   tab the person shared; HttpOnly cookies, saved passwords and other sites' data are never
   reachable.

### ADR 0002

The extension and host carry page automation only. ace never reads, stores or proxies the
person's browser credentials or provider credentials, and the daemon stays local: the host
connects only to `127.0.0.1`. The host's own credential is a daemon device credential with the new
local-only scope **`user-browser`**: it can register a browser link and nothing else (no reads,
no operate, no admin, no pairing, no socket tickets), exactly like the desktop's `desktop` scope.

### Transport

```
extension (service worker) ⇄ native messaging (stdio) ⇄ host (Node) ⇄ WebSocket ⇄ daemon
```

- **Native host.** Name `dev.ace.user_browser`. Its manifest (`type: "stdio"`, `allowed_origins`
  = the ace extension's fixed origin only) is written to each installed browser's per-user
  `NativeMessagingHosts` directory. `path` is a small launcher script in
  `<dataDir>/user-browser/` that runs the daemon's Node on the host entry with `--data-dir`.
  Windows needs registry keys and is not supported yet.
- **Framing.** Chrome's native messaging framing: a 4-byte length in native byte order (little
  endian on every platform ace ships) then UTF-8 JSON. Chrome limits host→extension messages to
  1 MiB; the host refuses larger frames instead of letting Chrome kill the port. The daemon socket
  takes at most 1 MiB per message, so the host turns an oversize reply into an error reply for that
  command and drops oversize events.
- **Daemon link.** The host reads `<dataDir>/daemon-endpoint` and its credential
  (`<dataDir>/user-browser/host-credential.json`, mode 0600) and opens the daemon's loopback
  WebSocket with a normal `hello` carrying that token. It relays only `user_browser.*` messages and
  validates both directions with the protocol schemas. If the daemon is down or restarts, the host
  retries with capped backoff (1 s to 30 s) and tells the extension the link state; the extension
  detaches every tab while the daemon is unreachable, then registers again.
- **Lifetime.** The extension's open native port keeps its service worker alive (Chrome 105+).
  Chrome starts one host per browser profile and kills it when the port closes, the profile
  closes or the extension is disabled, updated or removed.

### Wire protocol (`packages/protocol/src/user-browser.ts`)

Extension → daemon (the host relays): `user_browser.register` (browser family and version,
a random per-profile id kept in `chrome.storage.local`, extension version), `user_browser.reply`
(a command result or error) and `user_browser.event` (`tabs` with the full allowed-tab list,
each agent popup with its `openerTabId`; `cdp` with a tab's CDP event, `sessionId` set for one of
its iframes; `detached` with a reason: `closed`, `revoked`, `stopped`,
`canceled`, `sensitive`, `unreachable`). Daemon → extension: `user_browser.registered` and
`user_browser.command` with an operation: `tabs.list`, `tabs.open {url?}`, `tabs.attach {tabId}`,
`tabs.detach {tabId}`, `tabs.close {tabId}` (agent tabs only), `cdp {tabId, sessionId?, method,
params}` and `stop`. Host → extension only: `user_browser.link` with the daemon link state.

Settings use `user_browser.settings` (`status`, `install`, `revoke`, `stop`) and its
`user_browser.settings.result`, admin scope only.

### Daemon backend

`UserChromeHub` (in `@ace/browser`) holds one `UserChromeLink` per connected browser profile (at
most 8). A link correlates commands (bounded in flight, 30 s deadline, navigations longer), routes
CDP events by tab and reports a tab's loss to its session. `UserChromeBackend` implements the
existing `BrowserBackend` interface with `kind: "user"`:

- `open(request)` asks the most recently connected browser for a new agent tab and attaches.
- `claim(request, tabRef)` attaches to a tab the person shared; it fails for any other tab.
- `sharedTabs()` lists what the person has shared, for the agent's tab list.

Each session is built from the tab's relayed CDP with the same building blocks as ace's Chrome:
CDP navigation, agent input chords, model screenshots, page status and console/network logs, so
snapshot, refs, click, type, wait, evaluate and the rest of `BrowserSession` work unchanged.
Differences: no request interception (the person's own browsing is not policed, and a paused
document must never hang their tab when the daemon is slow); the extension enforces the scheme
policy instead. `resize` emulates a viewport only on agent tabs; a shared tab keeps the person's
size. Closing an agent session closes its tab; closing a shared session only detaches.
Alerts, confirms and prompts are reported as the tab's `pending_dialog` and answered with
`Page.handleJavaScriptDialog` (the person can still answer them in their browser; a
`beforeunload` in an agent tab is accepted). Snapshots and refs reach same-origin frames through
the tab and cross-site frames through their child sessions. Downloads are not reported: the
person's browser saves them itself, so `ace_browser_downloads` fails at once with
`not_supported` instead of waiting for a download it can never see. Loss of a
tab, link or browser closes the thread's session; it never falls back to ace's own browsers,
because the page's logins would not come with it.

### Lifecycle

- **Browser closed or crashed:** the host's stdin closes, the host exits, the daemon socket
  closes, every session on that link is lost.
- **Extension updated or reloaded:** Chrome kills the port and the host; the new service worker
  reconnects and registers again with the same profile id. Previous sessions are lost.
- **Daemon restart:** the host keeps running, reconnects, the extension detaches everything and
  registers again.
- **Multiple browsers and profiles:** each profile runs its own extension instance and host, so
  each is its own link, identified by family and profile id. Settings lists them all; `open` uses
  the most recently connected one until H1 lets a call name a link.

### Distribution

For now the person loads the extension unpacked. Settings › Install writes the built extension
to `<dataDir>/user-browser/extension` and shows that path and the steps. The manifest carries a
fixed public `key`, so the extension id (`colganbkmbpfajldlcclkcmpeoicoaka`) is stable for unpacked
installs and the host manifest's `allowed_origins` can name it. The private key was not kept; a
Web Store listing will get the store's key and both ids will be allowed. Supported for host
install: Chrome, Chrome Beta/Dev/Canary, Chromium, Edge, Brave, Vivaldi and Arc on macOS and Linux
(Arc on macOS only).

The extension's code is bundled with esbuild into a committed generated module
(`extension-bundle.gen.ts`), as the annotation overlay is; `bun run check:extension` fails when
the bundle is stale, and the daemon writes the unpacked directory from it without a build step.

## Rejected

- **Remote debugging the person's profile** (`--remote-debugging-port` or pipe): Chrome refuses it
  for the default profile, and it would give ace every tab.
- **Copying the person's profile into ace's Chrome:** that is credential extraction.
- **`chrome.tabs.captureVisibleTab` and content scripts instead of `chrome.debugger`:** no trusted
  input, no accessibility tree, and a second implementation of every command.
- **The extension talking to the daemon directly over WebSocket:** any web page could find and
  attack the port, and the extension would need to store a daemon credential. Native messaging is
  reachable only from the extension ids the manifest names.

## Evaluate restriction (amendment, 2026-10-17, #939)

Trust model point 6 allowed page script an agent evaluates to read what the page itself can,
including non-HttpOnly cookies and web storage. In the person's own browser that is their real
sessions, so `evaluate` from an agent on this backend is now restricted unless the person turns
on **`browser.userChrome.storageReads`** (off by default, Settings › Computer use › Use my
Chrome):

- It runs in a fresh isolated world (`ace-evaluate`) of the top document, not the page's world.
  It reads and changes the DOM as before; it cannot see page script variables.
- Before the expression runs, that world replaces `document.cookie`, `localStorage`,
  `sessionStorage`, `indexedDB`, `cookieStore`, `caches`, `Storage` methods, `window.open`,
  `opener`, `frames` and the frame-content accessors with non-configurable accessors that throw,
  in this document and in every same-origin frame reachable now. Creating frame elements or
  inserting markup that holds one throws too, so no fresh frame realm with the original APIs can
  be reached. A refused read fails with a message that names the setting.
- `read-only` keeps its V8 side-effect check on top.

This is a capability restriction, not an approval prompt: ace adds no prompts of its own for its
MCP tools (permissions stay provider-native, ADR 0067 as superseded 2026-10-14). It is not an OS
sandbox either: a browser bug could open a path the lockdown does not cover. People's own
`evaluate` (the person's actor) and the other engines are unchanged.

## Integration with the multi-tab runtime

- The daemon starts one `UserBrowserService` (`apps/daemon/src/user-browser.ts`) as
  `services.userBrowser`; it owns `hub` (`UserChromeHub`) and `backend` (`UserChromeBackend`).
  The socket service `services/user-browser.ts` registers host links and answers Settings.
- Threads' browsers in the person's Chrome run in a second `BrowserService`
  (`services.userBrowserSessions`, data under `<dataDir>/user-browser/threads`) whose only backend
  is `UserChromeTabsBackend`, kind `user`: the thread's tabs there, with the same tab runtime,
  queues, refs and tools as ace's own browser. Its tabs are the agents' tabs (each
  `backend.open`, in the ace window) and every tab the person shared (`sharedTabs()`), listed with
  `openedBy: {kind: "human"}`. A shared tab is claimed (`backend.claim`) only by the first
  command that uses it, so listing never attaches to the person's tab; closing it in ace only
  detaches. ace's own viewers are shown an agent tab, never a shared one, and a thread there
  always keeps one agent tab. A popup of one of the thread's agent tabs is adopted
  (`backend.adopt`) as a tab of the thread, opened by whoever drove its opener; over the thread's
  tab limit it is closed. Tab titles are the extension's.
- Every agent browser tool takes `browser: "user"` (MCP schema `browserChoiceInput`, explained
  in the tool descriptions and the `ace-browser` skill) to act there; omitted or `"ace"` is ace's
  browser. With no browser connected the call fails with `user_browser_unavailable`. `browser:
"user"` never combines with `machine`.
- On `lost` from a `user` tab: the tab leaves the list; when the thread's last agent tab, or the
  link, is lost the thread's session there closes. It is never suspended for recovery and never
  moves to ace's own browsers (`BrowserService` only recovers `embedded` sessions).
- Extensions have no `Memory` domain; the session answers `Memory.getDOMCounters` (the snapshot
  and text-wait size guards) by counting nodes in the page.

## Verification

Unit tests cover the framing codec (split and joined chunks, limits), the extension's page and CDP
policy, the extension id derivation (checked against an id Chrome itself reported), manifest
installation into a temporary home for each browser and platform, and the daemon link's
deadlines, per-tab event routing and profile replacement. A daemon socket test installs through
Settings, connects with the minted credential, shows it can register a browser and is refused
Settings and storage, and that revoking closes it. A relay test runs the host's relay against a real local WebSocket server
standing in for the daemon. An end-to-end process test launches Chrome for Testing headless over a
pipe with `--enable-unsafe-extension-debugging`, loads the built extension with
`Extensions.loadUnpacked`, registers the real host under `<user-data-dir>/NativeMessagingHosts`,
connects it to a daemon-side `UserChromeHub` on a real WebSocket, and drives a local fixture page
through `BrowserService` (navigate, snapshot, click by ref) via daemon → host → extension → page.
A daemon process test drives the MCP tools with `browser: "user"` against a stand-in extension
on a real link: the agent's tab opens in the person's browser, a shared tab is listed as the
person's and attached only on first use, a lost browser closes the thread's session there, and
ace's own browser is never opened. The shared browser conformance suite
(`packages/browser-extension/src/conformance.process.test.ts`) runs every engine scenario against
this backend, with downloads declared `not_supported`.
