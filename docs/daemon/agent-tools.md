# Agent browser and computer tools

ace publishes one session-scoped MCP server on daemon loopback. Its credential
selects the thread and agent. Never pass `threadId`, `agentId`, `sessionId`, or a
credential in tool arguments. A closed provider session loses its MCP authority.
Discover the tool catalog for the current session before choosing tools.

Use ace's tools for the thread browser and delegated devices. Provider-specific
browser extensions and `cua_repl.js` do not control ace's thread browser, do not
share its origin approvals, and are not part of this contract.

## Browser journey

1. `ace_browser_open({url: "http://localhost:3000/"})` opens the thread browser
   and waits for the initial document. Omitting `url` opens a blank browser. Add `newTab:true` for another background tab.
   Other browser tools also open it lazily.
2. `ace_browser_snapshot({})` returns bounded accessibility `nodes`, with
   `name`, `role`, optional `value`, and optional `ref`. Only nodes with refs
   can be targeted. Take a new snapshot after navigation.
3. `ace_browser_click({ref: "e1-42"})` clicks the element's centre.
   `ace_browser_type({ref: "e1-43", text: "Ada"})` replaces the editable
   element's contents. `ace_browser_press({ref: "e1-43", key: "Enter"})`
   focuses it and sends a key. Omitting `ref` uses the focused element.
4. After submitting, use `ace_browser_wait_for({url: "http://localhost:3000/results"})`
   for an exact destination through DOMContentLoaded, or
   `ace_browser_wait_for({text: "Saved"})` for a bounded visible-text substring.
   These check the current document, so they work if navigation already finished.
   A URL includes its query string and fragment. A loaded error document is not
   proof that a submission succeeded; inspect its content.
5. Snapshot again to read results and obtain current refs.
   `ace_browser_screenshot({})` returns an inline JPEG of the viewport, capped
   at 1536 pixels on its longest side. Capture scaling does not change layout.

Choose exactly one wait condition: `url`, `text`, or `ref` with
`state: "visible" | "hidden"`. The element form applies to the current document;
it cannot wait for a destination element whose ref does not exist yet. Wait and
navigation `timeout` values are milliseconds, default 10000, maximum 30000.
Origin approval pauses the load budget, including an approval begun by a click
before the wait was submitted. The total approval reserve is at most 65000 ms.
Cancellation does not return a late success. Each text poll visits at most 1024 DOM nodes
and 65536 text characters, and rejects documents over the 20000-node snapshot cap.
Larger searches return `page_text_limit` instead of repeatedly scanning the page.

Refs include frame identity, a document generation and Chromium node identity. They remain
stable across snapshots of an unchanged element in the same document, but only
the latest snapshot grants actionable refs. Navigation, detached elements and
backend replacement require a fresh snapshot. A ref is not a CSS selector.

| Tool                   | Arguments and result                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `ace_browser_navigate` | `url`, optional `timeout`; HTTP(S), no URL credentials; returns browser state                     |
| `ace_browser_scroll`   | `x`, `y` are horizontal/vertical pixel distances, not target coordinates                          |
| `ace_browser_evaluate` | `expression`, optional `mode: read-only / unrestricted`; bounded JSON; separate evaluate approval |
| `ace_browser_logs`     | optional kind, level, url substring, status, limit; returns bounded redacted inline entries       |
| `ace_browser_resize`   | `width`, `height`, 100–4096 CSS pixels                                                            |
| `ace_browser_emulate`  | `width`, `height`, optional `deviceScaleFactor`, `mobile`, `touch`, `colorScheme`                 |
| `ace_browser_close`    | `{}`; closes the thread browser after agent control is restored                                   |

## Origin consent and control

Read-only refuses agent navigation, including loopback and previously granted
origins. Ask and Auto-review allow loopback or granted origins. A new external
origin opens a blocking host approval for the exact origin. The agent waits; it
must never resolve its own approval. Human choices are Allow once, Allow for this
thread, and Deny. Full access allows new origins without human work and without
creating permanent grants. Resources, redirects and WebSockets share the origin
policy. Site consent does not grant JavaScript evaluation.

Browser takeover and handback are authenticated human operations, not agent
tools. A human lease blocks agent input and agent close. Takeover invalidates
queued input even if the human hands control back before it dispatches. A click
already dispatched cannot be undone. Shared disconnect returns browser control; refresh the snapshot before continuing. Private takeover returns `human_private` for agent reads as well as input. A private disconnect pauses until explicit human handback; the agent must wait.

## Tabs, files and inspection

`ace_browser_tabs({operation:"list"})` returns stable IDs and the active tab.
Use operation open with optional url, or switch/close with tabId. The last tab
requires ace_browser_close. Each thread has at most eight tabs; the daemon has
at most 32. Popups are policy-checked background tabs. Commands accept optional
tabId to select their target; snapshot again after switching.

`ace_browser_find({role:"button",name:"Save"})` returns matching snapshot nodes;
exact defaults true. Hover/focus/check/uncheck take ref, drag takes ref and toRef,
and select takes ref and option values. Frame-qualified refs target same-origin
and cross-origin frame elements through their CDP sessions.

`ace_browser_upload({ref,files:["relative/workspace/file.txt"]})` sets a file input.
Workspace and thread artifact files are allowed; outside paths require a human.
Downloads are quarantined and need a separate browser.downloads approval in
Ask/Auto-review. Completed downloads announce an artifact with filename, size,
MIME and executable/archive flags. Never execute or open a flagged file by default.

A tab may carry pending_dialog with dialogId, tabId, type and message. Answer with
`ace_browser_dialog({dialogId,accept:true,promptText:"text"})`, or accept:false to
dismiss. Agent-owned beforeunload is accepted automatically. Native permission
prompts and file chooser windows do not grant capabilities.

Evaluate defaults to unrestricted. Use mode read-only to read DOM in an isolated
world with side-effect checking. It refuses mutation, navigation and network calls;
it cannot read page-world variables and may refuse harmless operations. Evaluation
has its own Allow once / Deny approval, plus a read-only site/thread grant option.
Full access evaluates directly. A site grant never permits unrestricted JavaScript.

`ace_browser_network_body({requestId})` reads one completed bounded text response
from a request ID in logs. Binary, incomplete, evicted or oversized bodies fail.
Known secrets are redacted; arbitrary page text can still be sensitive.
`ace_browser_record_start({})` and record_stop reuse the recording/artifact pipeline.
Recording captures the active view; private frames are excluded. Recording is not replay.

The [UI wire handoff](browser-parity-ui.md) defines tab/download/dialog state,
grants, private reconnect and the human approval controls.

## Screen journey

A human enables screen access and grants the helper's OS permissions. Call
`screen_request_app({bundleId, reason})` for a host approval (this turn, this thread,
always or deny), then `screen_open_app({bundleId})` to launch without activation
and acquire a background session. Sensitive apps always ask. A human can also
start and delegate a session. Up to eight distinct macOS apps share one helper;
`target_busy` identifies the existing holder. Session tools accept `sessionId`;
include it whenever the agent controls multiple apps. Cross-agent selection fails.

Use `screen_ui_tree({})`, or
`screen_ui_find({query: {name: "Name"}})`, then
`screen_ui_act({ref: "…", action: "setValue", value: "Ada"})` or
`screen_ui_act({ref: "…", action: "press"})`. Use only actions listed on the node.
Action replies include mode, whether synthesized input was needed and a fresh settled snapshot. Nodes advertise named secondary actions; `selectText` accepts text or a range. Refresh expired refs.
OS accessibility support varies; unsupported operations return an error.

`screen_type({text: "Ada"})` uses AX selected text before process-posted keys.
`screen_paste({text: "Ada"})` saves and restores clipboard representations.
Secure text fields refuse typing, keys and paste without human session consent.
`screen_key({key: "Enter"})` sends a named v2 key.
`screen_click({x: 10, y: 20})` uses target-window points on v2.
`screen_scroll({dx: 0, dy: 100})` scrolls, with optional target-window `x`, `y`.
Legacy v1 MCP tools instead use pixels in the latest model screenshot, macOS
`keyCode`, and `deltaX`/`deltaY`. ace maps model pixels back to the original capture
for click and scroll positions, including Retina captures. A controller or capture
geometry change requires a fresh screenshot before coordinate input. Viewer input
keeps its original capture-pixel contract. Prefer semantic refs to coordinate input.

`screen_screenshot({})` returns an inline JPEG and its pixels-per-target-point
scale for v2. Divide screenshot coordinates by that scale before v2 input. For v1,
pass pixels from the model image directly as described in its text block. Screen and
device model images are capped at 1536 pixels and 1 MiB. Large images require
ffmpeg on the daemon host for resizing; a missing encoder returns a typed remedy.
Live-view frames retain their original resolution.

Background input never activates the app or uses HID input. `foreground_required`
means the app needs an explicitly approved escalation; request it with
`screen_request_foreground({sessionId, reason})`. Unsupported background events
are never silently retried in foreground. Every action waits for a bounded UI
settle; agents do not need to sleep. Occluded windows can be captured; minimized
or off-display windows report explicit errors. Locked-Mac compatibility needs a
live check. Windows/Linux background input remains a follow-up.

Human takeover removes screen delegation. The human must delegate again before
agent tools resume. Ending the provider lease releases its delegated control. The global human kill
switch stops all sessions and blocks reacquisition until enablement is renewed.
See the [UI wire handoff](background-computer-use.md).

## Device journey

A human enables devices, approves one for the thread, and delegates its controller
lease. `device_list({})` returns only devices approved for that thread. All other
device tools take `deviceId`, for example `"android:Pixel"` or `"ios:UUID"`.

Call `device_boot({deviceId})` if needed, then `device_start({deviceId})` to start
capture before `device_screenshot({deviceId})`. Use `device_ui_tree`,
`device_find` with `query`, and `device_act` with `ref` and `action`, following the
screen semantic contract. Android refreshes accessibility targets before input
and reports adb input fallback. To type, focus the element then call `device_type`.
`device_key` accepts `home`, `back`, `rotate`, `enter`, or `power`.

Coordinate tools are `device_tap`, with `x`, `y` and optional `durationMs`, and
`device_swipe`, with `x`, `y`, `toX`, `toY`, and optional `durationMs`.
Coordinates use target points, with screenshot scale reported in text.
`device_open_app`, `device_open_url`, `device_install`, `device_logs`,
`device_record_start`, `device_record_stop`, and `device_stop` use the same approved
device. Installation paths are local to the daemon, not the agent's remote client.

Input renews the 30-second device controller lease. Human takeover, lease expiry,
disconnect, revocation and daemon restart invalidate queued agent input. A human
must delegate again after expiry or takeover. Viewing or taking a screenshot does
not grant or renew input authority. Restart never restores approval/control.

## Errors and provider delivery

Execution failures return MCP `isError: true` and text containing bounded JSON
`{code, message, hint?}`. Origin failures also contain `blocked: {origin, reason}`.
Only ace-authored public failure types expose fixed messages and remedies. Arbitrary
backend messages, hints, stacks, strings and code-shaped objects become a fixed
`execution_failed` response. Schema errors expose no private issue literals.
Examples include `stale_ref`, `controller_changed`, `delegation_required`,
`lease_required`, `read_only`, `denied`, and `invalid_arguments`. Malformed backend
results return `invalid_data` so the agent is not told to change valid arguments. Allowlisted native screen
error codes, including `target_gone` and `permission_denied`, are retained with
fixed guidance. Unknown native codes use a generic failure.
Capacity, cancellation and result-limit failures also return readable text.
Stack traces, input dumps and echoed ace bearer credentials are not returned.
Read the error before retrying; delegation and approval failures require a human.

Daemon tool deadlines include lazy browser startup and origin approval. Codex
gets `mcp_servers.ace.tool_timeout_sec=300`; Claude gets `MCP_TOOL_TIMEOUT=300000`;
OpenCode 2.0.22 gets the remote server's `timeout.execution=300000`. These settings
come from the installed provider interfaces; Pi uses advertised `ace/timeoutMs`.
ACP defines no portable execution-timeout override. Its provider must permit the
advertised daemon deadline. SDK/CLI versions can still impose their own limits.

Codex sends `mcp_servers.ace` with `http_headers.Authorization` in the native
`thread/start`, `thread/resume`, or `thread/fork` RPC configuration. The bearer is
absent from the app-server argv and shell environment. Claude's SDK HTTP MCP
configuration travels through a session-owned `--mcp-config` file: directory
0700, file 0600, outside the workspace, removed when its supervised process exits.
Pi reads the same private storage mechanism into its extension closure and deletes
the file-path environment variable before registering agent tools. Neither the Pi
MCP bearer nor its rollback control secret is inherited by shell commands.

OpenCode's direct status tool is `ace_ace_status`, because it prefixes MCP tool
names with their server name. Claude uses `mcp__ace__ace_status`; other
providers use their advertised ace server/tool prefix. Call status or read
`ace://status` to check availability. A disabled tool group does not imply
that ace is absent.

OpenCode also receives a credential-free native readiness plugin through its
runtime configuration. Session admission waits for the actual native
`ace_ace_status` registration, because MCP connection status precedes the
provider's debounced tool reload. The plugin carries no MCP authority, changes
no user configuration files and is staged in standalone releases. See the
[isolated CLI results](../research/providers/opencode-ace-tools.md).

OpenCode v2 gets one owned process per scoped lease. Before admission, ace uses
its in-memory, location-scoped `mcp.add` and `mcp.connect` APIs and checks the native
catalog reports `connected`, then waits for native tool readiness. The v2 config shape is `mcp.servers.ace`, with
`disabled:false`, `codemode:false`, and `oauth:false`. Code Mode would otherwise
hide individual tools behind a code-execution tool. No ace bearer is added to
`OPENCODE_CONFIG_CONTENT`, persisted provider config, or project config. Existing
user MCP servers are preserved; an `ace` name collision fails admission.

ACP HTTP headers travel in its native session RPC as an array of name/value pairs.
For providers that advertise only stdio, ACP has no portable private-header
mechanism: the supervised bridge child receives `ACE_MCP_BRIDGE_BEARER` in its
own environment. It is absent from the parent provider's environment and shell
children, but a same-user process can inspect the bridge. Cursor SDK HTTP headers
travel through host options and IPC, never a spawned bearer environment variable.
Private files also protect against accidental `env`/argv disclosure, rather than
against arbitrary same-user filesystem or process inspection.

Production credentials expire after one hour, are scoped to a single thread and
agent, and are revoked on session exit, cancellation, adapter close, or daemon
shutdown. Expiry aborts in-flight tools, releases browser/screen/device controllers,
and closes the owning provider session. A later session receives fresh authority.

Cursor SDK receives the same scoped capabilities through its host options. Its read-only or unsupported-sandbox
fallback intentionally excludes MCP; full access or supported sandbox admission
is required for browser/computer tools. Unsupported ACP transport fails explicitly.

OpenCode's “Network trouble” banner follows a native `session.retry.scheduled`
event whose provider error is classified as network-related. The owner report
included `ECONNRESET: The socket connection was closed unexpectedly` (attempt 2).
An MCP `session.tool.failed` event instead creates a failed tool result; it does
not create that network retry status. Correct native registration removes the
manual urllib workaround but cannot prevent a provider model-stream connection
reset. See [native verification evidence](native-mcp-verification.md).

## Offline regression harness

The owner permits test execution only at merge. These are merge-time regression
suites, not development commands:

- `apps/daemon/src/agent-browser-journey.process.test.ts`: real daemon MCP and
  installed Chromium against a gated localhost form, results, screenshots,
  refs, takeover and origin modes. External approval cases use a fake backend.
- `apps/daemon/src/agent-computer-journey.process.test.ts`: real daemon MCP,
  helper subprocess and fake device I/O, with observable edited screens and
  lease/revocation behavior.
- `apps/daemon/src/provider-mcp.process.test.ts` and
  `apps/daemon/src/cursor-sdk-tools.process.test.ts`: fake native providers consume
  injected config and call the daemon toolkit without provider prompts.
- `packages/browser/src/ref-dispatch.process.test.ts`: resolution and cleanup
  barriers observe focus, selection, scroll and destination input.
- `apps/daemon/src/browser-paused-owner.process.test.ts`: suspended human ownership
  still blocks MCP close.
- `packages/screen/src/model-input.process.test.ts`: legacy image midpoint reaches
  the native target centre at scales 1 and 2.
- `packages/browser/src/text-wait.process.test.ts` and `wait-readiness.process.test.ts`:
  bounded text searches and a held document readiness condition.
- `packages/mcp-server/src/model-image-failures.process.test.ts`: injected encoder
  discovery and deadlines with local fake child processes.
- `packages/browser/src/control-journey.process.test.ts`: queued input and
  click-origin approval races with injected time.
- `apps/daemon/src/screen-queued-cancel.process.test.ts`: cancelled input never
  dispatches after an earlier native action finishes.
- `packages/mcp-server/src/model-image.process.test.ts`: real local image encoder.

The harness uses temporary homes. It does not invoke installed provider CLIs,
record paid sessions, drive the user's OS, contact external sites, or use
`~/.ace-next`. Missing Chromium or ffmpeg produces an explicit test skip; no
automatic download occurs. Real OS permission and provider-version compatibility
remain separate installation checks.

## Performance verification at merge

`packages/browser/bench/text-wait.ts` is a localhost, temporary-home benchmark
for 100, 500 and 10000 nodes and an oversized 65537-character text node. It records
100 samples per case, p50/p95 wait latency, bounded-limit results and RSS. It has
not been executed under the owner rule. Measured latency and memory need run at
merge; the numerical limits above are implementation budgets, not benchmark results.

See [interaction smoothness measurements](interaction-measurement.md) for bounded screen/browser timing tools, repeat summaries and filmstrip interpretation.
