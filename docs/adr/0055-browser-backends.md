# 0055: Embedded browser and daemon headless fallback

Date: 2026-10-02. Status: proposed. Amends ADR 0009.

The background backend default, tabs, files and private-control behavior is amended by
[ADR 0067](0067-browser-parity.md).

## Decision

Browser automation runs in ace's browser. New sessions prefer the connected
Electron desktop backend. Otherwise the daemon launches an ace-owned, pinned
Chromium using playwright-core. Neither path opens a personal browser profile.
`BrowserService` remains the only agent/client API. Policy, stable DOM refs,
controller leases, recording, logs and viewer fan-out stay in the service.
`BrowserBackend` opens a session with a CDP transport and small page operations.
The headless implementation wraps public Playwright APIs. The embedded
implementation relays CDP over the authenticated daemon socket. No Electron
code belongs to the daemon package.

`browser.backend` is a layered setting, `auto | embedded | headless`, default
`auto`; thread settings override workspace/global settings. `embedded` fails
explicitly when unavailable. Existing sessions keep their selected backend. The legacy `headed` open field is
accepted for wire compatibility; fallback sessions always launch headlessly.
`browser.backendLoss` is `pause | headless`, default `pause`. Loss always emits
`browser.backend.lost` and a state with `status: paused`, `controller: none` and
an explanation. Headless recovery reopens the last approved URL in an ephemeral
profile. It reports `pageStateLost: true`; cookies, history, refs and JS state
are not migrated. Human ownership is retained through recovery. Commands never
replay automatically. Close cancels recovery. A paused session can be closed
and reopened after the user chooses a backend.

## Desktop contract, version 1

The daemon writes a private `browser-desktop.json` credential in its data dir.
Desktop reads it locally, connects to the local daemon URL using the existing
host-token hello and the credential's device id, then sends:

- `browser.backend.register`: `requestId`, `credential`, `version: 1`, and
  `capabilities`. All version-1 capabilities are required: `cdp`, `targets`,
  `permissions`, `downloads`, `controllerLease`.
- `browser.backend.registered`: matching `requestId`, `backendId`, `connectionId`.

The second credential is desktop-scoped, checked against the authenticated
connection's device id. Desktop credentials cannot be paired or used for
remote socket tickets. Ordinary host/admin authority does not register a
backend. The daemon accepts one desktop backend at a time; replacement requires
disconnecting the old one. Credential revocation closes its backend.

Daemon sends `browser.backend.request` with `backendId`, unique `id`,
`sessionId`, and `operation`. Desktop responds `browser.backend.response` with
the same identifiers and either `result` or `error`. Supported operations:

- `open`: thread/workspace/profile, viewport, and a daemon controller lease.
  Create an ace-only WebContentsView partition. Persistent partitions belong
  exclusively to the workspace; ephemeral partitions are removed on close.
  Return `{url}`. Install deny-all permission handlers and deny downloads,
  dismiss dialogs, block service workers, close popups and intercept WebSockets
  before reporting success. Attach CDP to the primary page. Preserve nested
  Target sessions and events; the daemon installs Fetch interception on them.
- `cdp`: `method`, optional `params`. Return the exact CDP result. CDP events
  use `browser.backend.event`, same backend/session, `method`, `params`.
  Navigation, console, network, Fetch, Target, screencast and close events must
  be forwarded. Report native denials as method `ace.permissionDenied` with
  `{origin, permission}` and `ace.downloadDenied` with `{url, suggestedFilename}`.
  Deny locally before emitting; these are audit hooks, never approval requests. Unknown CDP fields remain opaque.
- `navigate`: URL and timeout. Await DOMContentLoaded or report an error.
  Return `{url}` with the final URL after redirects; evaluation approval and
  recovery use this URL.
- `press`: Playwright-compatible keyboard key/chord string.
- `resize`: width/height. Resize the actual view and CDP viewport.
- `controller`: monotonically increasing `generation`, controller and optional
  human connection owner. Return after applying the lease. Native view input
  is enabled only when `controller` is `human` and `owner` equals the registered
  `connectionId`; another device's human lease keeps native input disabled.
  Native take-control uses the existing
  browser.takeover connection; local pointer input follows that lease.
- `close`: destroy the view, detach CDP, remove ephemeral partition data.

Screenshots, accessibility, ref actions, evaluation, mouse/text/touch input,
media emulation, logs and screencasts use CDP. Evaluation approval is checked by
the daemon immediately before dispatch. Native permissions and downloads are
fail-closed hooks at the backend boundary; version 1 never grants either.
Desktop must not independently navigate around daemon Fetch/origin approval.

Relay admits at most 128 unsettled requests, eight sessions, and 1 MiB per
command/result/event. Requests time out at 30 seconds, session open at 60 seconds.
An outbound transport that refuses a reliable message disconnects the backend;
commands are never buffered without a bound. Event forwarding is synchronous.
For frames, desktop keeps one in-flight frame and one replaceable latest frame
per session, bounded to 768 KiB encoded. It acknowledges CDP immediately,
replaces pending frames under pressure and sends them after daemon
`browser.backend.frameAck` for the in-flight frame. The daemon validates and
acknowledges each frame independently of viewer acknowledgements. It removes
all pending requests/listeners on loss. `Inspector.detached` loses only the
identified view: its pending requests reject immediately, its listeners and
abort hook are removed, and other sessions remain usable. A controller lease
error can pause a session without losing the transport; later view/app loss
still emits the loss event and applies the configured recovery policy. Backend
loss is deduplicated independently of paused status. No reconnect reuses a session id.

## Chromium acquisition

The fallback lazily streams a version-pinned Chrome for Testing archive into
`dataDir/chromium`, reports bytes/progress, verifies the published checksum
before extraction, and atomically publishes a completed installation. Archives,
expanded bytes, entries and paths are bounded. Partial or corrupt installs are
removed and can be retried. The pin is Chrome for Testing 153.0.8010.12,
matching Playwright 1.61.1, with the publisher's MD5 transfer checksum and immutable
Google Storage object generation. HTTPS authenticates the publisher; MD5 alone
is not a signature. The installed executable also has a SHA-256 cache digest.
Supported artifacts are Linux x64, macOS x64/arm64 and Windows x64. Linux/Windows
arm64 fail explicitly rather than silently selecting a personal installation. Downloads are single-flight per service and abort
on shutdown. Existing browser discovery remains a diagnostic/test API; the
production service never searches PATH, applications or personal Playwright
caches. Explicit executable injection remains available at the trusted service
boundary for CI and host packaging, always with an ace-owned profile.

Sources: [Chrome for Testing](https://developer.chrome.com/blog/chrome-for-testing/),
[CDP](https://chromedevtools.github.io/devtools-protocol/),
[Playwright](https://playwright.dev/docs/api/class-browsertype).
The release notes supplied in the brief establish requirements only; no
competitor source was read.

## Verification and limits

Behavior tests cover a socket-backed fake desktop, backend routing, controller
handover, disconnect pause/recovery, stale refs, acquisition against a local
HTTP server and rejected checksums. Existing browser suites use the headless
implementation through the interface. A shared service contract runs against
both backend test edges. An unskipped first-use integration acquires the owned
pin and tests the real headless browser; merge must supply host Chromium
runtime dependencies and publisher access. Fake provider CLIs consume Codex
argv/env, OpenCode JSONC overlays, and negotiated ACP HTTP/stdio definitions,
then discover and invoke browser tools over the real MCP server. A gated HTTP
archive verifies that transfer progress precedes download completion. Relay
benchmarks include per-view detachment with unrelated pending requests; the
acquisition benchmark reports throughput and peak RSS.
Tests, mutation runs and benchmarks are not executed under the owner's policy;
all runtime claims need run at merge. Version 1 grants no native browser
permissions or downloads. The desktop agent implements the bridge separately.
