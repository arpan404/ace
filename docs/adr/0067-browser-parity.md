# 0067: Background browser tabs and private human control

Date: 2026-10-05. Status: accepted.

## Context

Agents need several pages in one thread and independent browser work across threads.
The one-page, download-denying contract in ADR 0009 cannot support that workflow.
This decision supersedes its primary-page limit, workspace profile lease, popup and
file/dialog restrictions, host-path log response, and automatic private handback.
It extends ADRs 0054, 0055 and 0061 without changing provider credential handling.

Requirements came from the supplied capability summary and public product docs:
[the built-in browser guide](https://help.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-desktop-app),
[enterprise policy](https://help.openai.com/en/articles/20001510-manage-browser-and-computer-use-in-your-enterprise-workspace),
and [release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes).
Implementation uses primary [CDP DOM](https://chromedevtools.github.io/devtools-protocol/tot/DOM/),
[Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/),
[Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/),
[Target](https://chromedevtools.github.io/devtools-protocol/tot/Target/),
[Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/), and
[Playwright download](https://playwright.dev/docs/api/class-download) contracts.
No other application's implementation or bundles were inspected.

## Decision

Each thread keeps its own context and command queue. The daemon's automatic
backend is headless. MCP opening explicitly requests background operation,
including when an embedded backend is connected. A legacy embedded thread may
convert to headless only under agent control; a human lease refuses conversion.
Conversion closes the old page and starts a fresh session. The embedded bridge
remains available when explicitly selected by a human, with its existing capabilities.
Agents do not depend on a desktop connection or visible browser window.

A headless context owns at most eight pages. A service-wide admission counter
limits pages to 32, independently of the existing eight-session limit. Page
reservations include tabs being initialized and release exactly once on failure,
page close, or context shutdown. Explicit creation, window.open and target=_blank
share this admission path. A popup's initial request passes the origin guard
before its document loads. Its own CDP session then handles requests, redirects,
frames and workers. Tabs remain in the background. The active tab chooses the
live-view capture and the default action target. Stable tab IDs survive switching;
only closing/reopening the context creates a new tab identity.

Persistent profiles now belong to a workspace/thread pair. Two threads never
share cookies, storage, permissions or page objects, even in one workspace.
The user's personal browser profile is never opened. Heavy Chromium code and
MCP descriptor registration remain behind first-use loading boundaries.

`ace_browser_tabs` lists, opens, switches and closes tabs. `ace_browser_open`
accepts `newTab`. Commands can select `tabId`; selection and input remain serialized
within a thread. Another thread can work while one thread waits for approval.
Closing the last tab requires closing the browser. Switching capture stops the old
screencast before starting the new one and retains increasing frame sequences.

## Files, dialogs and semantic input

Downloads require origin permission and an independent `browser.downloads` host
approval in Ask and Auto-review. Full access permits them directly. Attachment
responses pass the download gate before Fetch continues. Browser download events
also check the gate, covering downloads not marked as attachments. Downloads stay
in a private session directory belonging to the thread. They never open or execute.
A CDP progress hook cancels oversized Chromium temporary files, and a bounded
stream independently enforces a 64 MiB artifact limit and 256 MiB thread-session
aggregate limit. Four transfers and 128 retained entries bound concurrency and
metadata. Chromium's transient download is deleted after publication or refusal.
Completed files create durable browser artifacts with filename, byte count, MIME
and executable/archive flags. Extension and MIME classification flags suspicious
files; it does not establish that a file is safe.

File input uploads use `DOM.setFileInputFiles` on a current snapshot ref. The host
resolves symlinks and allows regular files inside the execution workspace or the
thread's browser artifact directory or an exact artifact path recorded for that thread,
including previous sessions. The artifact ownership lookup uses an upload-only
SQLite path index; its initial build scans artifact metadata, and subsequent checks
do indexed lookups rather than reading transcript history. Outside files require explicit human approval,
even in Full access. A batch has at most 16 files and 64 MiB. File paths are
rechecked after approval and before dispatch. CDP takes paths rather than file
descriptors, so a hostile local writer can still race the final path check. This
is a local filesystem limitation, not an atomic containment guarantee.

Alert, confirm and prompt stay pending with a dialog ID, tab ID, message and
optional default prompt. `ace_browser_dialog` accepts or dismisses the current
pending dialog and can provide prompt text. Synchronous dialog triggers return
`pending_dialog` while their renderer operation is paused; answering unblocks it.
Other page commands cannot overtake that operation. Obsolete IDs fail. Beforeunload is
automatically accepted only under the agent lease. Native permissions remain denied;
file chooser windows do not grant filesystem access.

Snapshots collect same-origin and out-of-process frames through their own CDP
sessions. Node IDs and refs include frame identity and document generation.
Navigation in an active page's frame invalidates the snapshot. The latest bounded
snapshot alone grants refs. Frame coordinates add the embedding element's content
origin through the parent chain. Hover, drag, select, check, uncheck, focus and
role/name find use the same refs and controller fencing as click and type.
Every awaited preparation checks the submitting lease again before input dispatch.
An action already dispatched into Chromium may finish after takeover.

## Evaluate and inspection safety

Origin approval never grants evaluation. Evaluate is a blocking engine host
interaction in Ask/Auto-review, including the proposed expression for review. Choices are Allow once, Deny, and for read-only
mode, Allow read-only JS for this site in this thread. Only the latter creates a
persistent exact-origin grant. It never permits unrestricted evaluation. The UI
can list/revoke these grants without opening Chromium. Revocation expires pending
approvals. Permission changes, cancellation, document changes and controller
changes are checked before evaluation dispatch. Full access evaluates directly.
Pending host approvals expire on close, cancellation or restart and do not replay.

Read-only mode creates an isolated world with universal access disabled and uses
`Runtime.evaluate` with `throwOnSideEffect`, a one-second execution budget, no
promise awaiting and the existing 256 KiB serialized-result bound. V8 refuses DOM
mutation, navigation and network calls when it cannot prove them free of side
effects. It also refuses some harmless functions. This mode reads DOM data but
cannot access the page world's JavaScript variables. It is not an OS sandbox or a
formal proof against browser bugs. It neither rolls back concurrent page activity
nor promises that the page itself stops its network writes. Unrestricted evaluation
retains the existing explicit approval boundary and ten-second execution budget.

Logs return at most 200 retained console/network entries inline, with kind, level,
URL-substring and HTTP-status filters. Each entry is bounded; older entries drop.
Network entries provide a tab-qualified request ID. `ace_browser_network_body`
retrieves one completed text response on demand, with a 256 KiB cap and redaction
through the shared redaction package. Binary, incomplete, evicted and oversized
responses fail. No response headers or request bodies are retained. URL credentials
and sensitive query fields are removed. Redaction detects known patterns and keys;
it cannot infer every secret in arbitrary prose.

## Private takeover and recording

Takeover has shared and private modes. Shared takeover retains the existing
agent-read behavior. Private takeover rejects every agent command and inline
screenshot with `human_private`, both before and after awaited reads. Agent open
cannot bypass this check. It invalidates refs, suppresses log and inspection
collection, refuses new downloads, cancels in-flight transfers and excludes live frames from recordings. Human
viewers can still see and operate the browser under their authenticated scopes.
Private mode protects data from the agent, not from another authorized human viewer.

A private controller disconnect clears its connection ownership and pauses browser
operation. The production engine also opens a blocking host gate so the thread's
agent tree cannot report done while private handback is pending. A new authorized
connection must take over and explicitly hand back; reconnect never restores agent
control automatically. Handback clears private mode and closes the host gate.
Closing the browser also closes the gate. After an unclean daemon stop, the durable
private gate restores private/paused control when its browser is reopened; a new
blank session cannot bypass handback. Backend loss remains independently paused.

`ace_browser_record_start` and `ace_browser_record_stop` reuse the bounded JPEG
pipeline, ffmpeg encoding/fallback player and durable artifact sink. Recording is
capture, not replay. Private frames and logs are excluded before disk collection.

## UI contract and verification

The wire handoff is [browser parity UI handoff](../daemon/browser-parity-ui.md).
The fake daemon implements the same tab lifecycle, dialog/download state,
evaluate-list/revoke and private reconnect transitions. Synthetic files and
recordings are fixture metadata rather than physical browser downloads.

Behavior tests use temporary profiles, local HTTP fixtures, real Chromium, real
SQLite and authenticated wire clients. They cover tab caps and isolation, popup
admission, same/cross-origin frame actions, file boundaries, dialogs, evaluate
side effects, approval decisions and revocation, private disconnect, recording,
inline redacted inspection and the existing browser journeys. Test commands and
performance measurements are recorded in the PR; only touched suites are run,
serially for Chromium. The daemon bench must include the startup module-load guard
and may run only when the host load average is below 15.
