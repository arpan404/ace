# Agent browser and computer tools

ace publishes one session-scoped MCP server on daemon loopback. Its credential
selects the thread and agent. Never pass `threadId`, `agentId`, `sessionId`, or a
credential in tool arguments. A closed provider session loses its MCP authority.
Discover the tool catalog for the current session before choosing tools.

Use ace's tools for the thread browser, native apps and simulators. Provider-specific
browser extensions and `cua_repl.js` do not control ace's thread browser and are
not part of this contract. ace's own tools never ask for approval: the provider
that calls them applies its own permissions, so every call ace receives proceeds.

## Browser journey

The thread browser is a real Chromium browser with tabs (ADR 0083) that the person
watches in ace, with a visible marker on the tab an agent drives. Prefer it to a provider's web fetch when the work
needs a rendered page: verifying UI, testing a dev server on localhost, letting the
person watch, or reading console and network evidence.

1. `browser_open({url: "http://localhost:3000/"})` opens or joins the thread browser
   and loads the URL in the caller's own tab, waiting for the initial document. It
   returns `tabId`, `url`, `title`, `controller` and `viewed` (whether the person is
   looking at that tab), plus a short `tabs` list when there are several. Without `url`
   it only reports. `tabId` loads the URL in another tab. Every other browser tool also
   opens the browser lazily.
2. `browser_snapshot({})` returns compact indented text, one line per meaningful
   accessibility node: `- button "Save" [disabled] [ref=e3-41]`, with field values
   after a colon and headings marked `[level=n]`. Ignored nodes, wrappers and text that
   only repeats its element's name are dropped. `maxNodes` (default 120, max 2000) and
   a 48 KiB cap bound the result; a cut snapshot ends with a `[truncated: …]` line.
   Narrow with `ref` (a container's subtree), `interactiveOnly: true`, or
   `browser_find({role, name})`, which returns matching lines from every frame.
3. `browser_act({action, …})` performs `click` (ref, or x/y in CSS pixels with optional
   button, clickCount and modifiers), `hover`, `focus`, `check`, `uncheck` (ref), `type`
   (ref and text; replaces the field's contents), `fill_form` (fields: `{ref, value}`
   list), `press` (key, optional ref), `select` (ref and option values), `drag` (ref and
   toRef), `upload` (ref and files), `scroll` (x/y pixel deltas) and `dialog` (dialogId,
   accept, promptText). A field another action does not use is refused with
   `invalid_arguments`. The result is `{ok, tabId, url}`, plus a note when the page
   navigated.
4. After an action that navigates, `browser_wait_for` with exactly one of `url` (exact
   destination through DOMContentLoaded), `text` (visible substring) or `ref` with
   `state: "visible" | "hidden"`. These check the current document, so they work if
   navigation already finished. Then snapshot again. `downloads: true` instead waits
   until the tab's downloads finish.
5. `browser_screenshot({})` returns an inline JPEG of the viewport, capped at 1536
   pixels on its longest side; `fullPage` captures the whole page and `ref` one element.
   It never moves the person's view. `format: "pdf"` prints the tab to a PDF file and
   returns its path. Use it for visuals; snapshots read structure.

### Tabs

Every page tool takes an optional `tabId`. Without one a call runs in the caller's
current tab (the last it opened or selected, keyed by the MCP scope's agent); an
identified agent whose fallback would land on another agent's tab gets a tab of its own.
Commands on different tabs run concurrently, and agent commands never move the tab the
person views.

`browser_tabs({action})`: `list` (the default; read-only) returns each tab's `tabId`,
`url`, `title`, `label`, `openedBy`, `drivenBy`, its `lease` while a person holds it,
a non-live `lifecycle`, `loading` and `pending_dialog`, with `current` on the caller's
tab. Private tabs show no address or title. `open` (optional `url`, `label`) opens a
tab of the caller's own and makes it current; `select` makes `tabId` current; `close`
closes `tabId` (closing the last tab closes the browser). Parallel agents each open a
labelled tab and pass its `tabId` to every call. Limits: 16 tabs per thread, 8 open per
agent, 48 across the daemon (`tab_limit`).

With "Use my Chrome" connected, every browser tool takes `browser: "user"` to act in
the person's own Chrome: `browser_open` gives the agent its own tab in an "ace" window
there, tabs the person shared list with `openedBy: {kind: "human"}`, and closing one
releases it without closing it for the person. Calls never fall back to ace's browser;
a disconnected Chrome answers `user_browser_unavailable`.

Wait and navigation `timeout` values are milliseconds, default 10000, maximum 120000.
Each text poll visits at most 1024 DOM nodes and 65536 characters; documents over the
20000-node snapshot cap are refused with `page_text_limit`.

Refs look like `e3-41` (main frame) or `f1:e3-41` (a child frame). They stay valid
across snapshots of an unchanged element until the document navigates, and they work
for every DOM-backed node of the latest snapshot, including ones the budget left out.
A ref is not a CSS selector.

| Tool               | Arguments and result                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `browser_logs`     | optional kind (console, network, downloads), level, url substring, status, limit; `requestId` reads a body  |
| `browser_evaluate` | `expression`, optional `mode: read-only / unrestricted`; bounded JSON                                       |
| `browser_history`  | no args: recent entries and back/forward; `direction`: back, forward, reload or stop                        |
| `browser_settings` | `action`: resize/emulate (width, height, scale, …), record_start/record_stop, extensions (read-only), close |
| `browser_measure`  | optional interaction, observeMs, repeat, filmstrip; frame-timing metrics                                    |

## Sites and control

An agent may open any `http(s)` address without URL credentials, in every
permission mode, without a question to a person. Resources, redirects and
WebSockets reach any `http(s)`/`ws(s)` origin. Other schemes such as `file:` and
`chrome:` fail with `invalid_origin`. Read-only tools (snapshot, find, wait_for,
screenshot, logs, history without direction, tabs list, settings extensions) are read-only; navigation and
input are open-world but never destructive.

Browser takeover and handback are authenticated human operations, not agent
tools. Leases are per tab: a human lease blocks agent input and agent close on that
tab only. Takeover invalidates
queued input even if the human hands control back before it dispatches. A click
already dispatched cannot be undone. Shared disconnect returns browser control; refresh the snapshot before continuing. Private takeover returns `human_private` for agent reads as well as input. A private disconnect pauses until explicit human handback; the agent must wait.

## Files, dialogs and inspection

`browser_act({action: "upload", ref, files: ["relative/workspace/file.txt"]})` sets a
file input. Relative paths resolve against the workspace; absolute paths are uploaded
too. Downloads are quarantined. Completed downloads announce an artifact with filename,
size, MIME and executable/archive flags. Never execute or open a flagged file by default.

While a page dialog is open, every tool returns `pending_dialog` with dialogId and a
hint. Answer with `browser_act({action: "dialog", dialogId, accept: true, promptText})`,
or accept:false to dismiss. Agent-owned beforeunload is accepted automatically. Native
permission prompts and file chooser windows do not grant capabilities.

Evaluate defaults to unrestricted. Use mode read-only to read DOM in an isolated
world with side-effect checking. It refuses mutation, navigation and network calls;
it cannot read page-world variables and may refuse harmless operations.

`browser_logs({requestId})` reads one completed bounded text response from a request ID
in the logs. Binary, incomplete, evicted or oversized bodies fail. Known secrets are
redacted; arbitrary page text can still be sensitive. `browser_settings` record_start
and record_stop reuse the recording/artifact pipeline. Recording captures the active
view; private frames are excluded.

The [UI wire handoff](browser-parity-ui.md) defines tab/download/dialog state
and private reconnect.

## Screen journey

A human turns computer use on and grants the helper's OS permissions. ace adds no
per-app approval: the provider's own permission mode decides each call, using the tools'
MCP annotations. `screen_open_app({bundleId})` launches without activation and acquires
a background session, returning a `sessionId` and candidate windows. Call it again with
`windowId` to switch window, `url` for a deep link, or `mode: "foreground"` for real
cursor and keyboard input (only when the app ignores background input).
`screen_windows({bundleId})` lists windows. Up to eight distinct macOS apps share one
helper; `target_busy` identifies the existing holder. Pass `sessionId` when the agent
controls several apps; cross-agent selection fails.

`screen_ui_tree({})` reads the bounded accessibility tree; with `role`, `name` or
`text` it finds matching elements instead. `screen_ui_act({ref, action: "setValue",
value: "Ada"})` or `screen_ui_act({menu: ["File", "New Window"]})` act semantically.
Use only actions listed on the node. Action replies include mode, whether synthesized
input was needed and a fresh settled snapshot.

`screen_input({action, …})` is the fallback: `click` (x, y), `type` and `paste` (text;
paste restores the clipboard), `key` (named key plus modifiers) and `scroll` (dx, dy,
optional x, y). Points are target-window points: divide screenshot pixels by the scale
`screen_screenshot` reports. Secure text fields refuse typing, keys and paste without
human session consent. `screen_screenshot` images are capped at 1536 pixels and 1 MiB;
large images need ffmpeg on the daemon host.

Background input never activates the app or uses HID input. `foreground_required`
means reopen with `mode: "foreground"`. Every action waits for a bounded UI settle;
agents do not need to sleep. Minimized or off-display windows report explicit errors.

Human takeover removes screen delegation, and agent calls on that app are refused while
the person holds it. Once they hand it back or release it, the agent resumes (or reacquires
it with `screen_open_app`). Ending the provider lease releases its delegated control. The global human kill
switch stops all sessions and blocks reacquisition until enablement is renewed.
See the [UI wire handoff](background-computer-use.md).

## Simulator journey

`sim_*` tools drive the iOS simulators and Android emulators on the daemon host. They
are unrelated to paired machines, which agents reach with `machines` and
`delegate`. A human turns the `devices` group on. `sim_list({})` returns every
simulator with its `simId`, for example `"android:Pixel"` or `"ios:UUID"`.

`sim_start({simId})` takes the simulator for the agent's thread, boots it when needed
(`boot` defaults to true) and starts capture, unless a person controls it or another
agent holds it (`lease_required` / `busy`). Read with `sim_ui({simId})`, or pass `role`,
`name` or `text` to find. `sim_act({simId, action: "ui", ref, uiAction})` acts through
accessibility; `tap`, `long_press`, `swipe`, `type` and `key` (`home`, `back`, `rotate`,
`enter`, `power`) are the coordinate and key fallbacks, in target points. `open_app`,
`open_url`, `install`, `record_start` and `record_stop` cover apps and recordings;
install paths are local to the daemon. `sim_screenshot` and `sim_logs` read, and
`sim_stop` releases it.

Input renews the 30-second controller lease. Human takeover, lease expiry, disconnect,
turning devices off and daemon restart invalidate queued agent input; the agent takes it
again with `sim_start`. Viewing or taking a screenshot does not grant input authority.

## Finding and reaching a tool

Not every client lists every tool (ADR 0082). `tools_find({query, limit?, family?})` is
listed everywhere: it ranks the tools this session could call right now (a group that is
off contributes nothing) and returns each match's name, title, one-line purpose, family,
effect (`read-only`, `changes` or `destructive`) and full input schema. For example,
"click a button in Safari" returns `screen_ui_act` and `screen_input` first, with
`screen_open_app` among the matches, while computer use is on, and none of them while it
is off; "check page console" returns
`browser_logs` first. The ranking is lexical and deterministic
(`packages/mcp-server/src/tool-search.ts`).

Cursor, ACP agents and Antigravity never reload their list, so they keep the core tools,
`tools_find` and `tools_call({name, arguments})`. `tools_call` runs the named tool
through the same path a direct call takes: the same schema validation and errors,
capability and group checks, timeouts and result. Its approvals, transcript row and
private-input redaction are the target's. It refuses to run `tools_find` or itself, and
an unknown name returns `tool_unavailable`, whose hint points at `tools_find`.

## Errors and provider delivery

Execution failures return MCP `isError: true` and text containing bounded JSON
`{code, message, hint?}`. Origin failures also contain `blocked: {origin, reason}`.
Only ace-authored public failure types expose fixed messages and remedies. Arbitrary
backend messages, hints, stacks, strings and code-shaped objects become a fixed
`execution_failed` response. Schema errors expose no private issue literals.
Examples include `stale_ref`, `controller_changed`, `delegation_required`,
`lease_required`, `denied`, and `invalid_arguments`. Malformed backend
results return `invalid_data` so the agent is not told to change valid arguments. Allowlisted native screen
error codes, including `target_gone` and `permission_denied`, are retained with
fixed guidance. Unknown native codes use a generic failure.
Capacity, cancellation and result-limit failures also return readable text.
Stack traces, input dumps and echoed ace bearer credentials are not returned.
A hint names the agent's next call, such as `lease_required` → "Call sim_start
for this simId." It names the person only when they are truly
required, such as human control or a disabled group. Read the error before retrying.

Daemon tool deadlines include lazy browser startup. Device installs
allow ten minutes of native execution and another 30 seconds for dispatch and completion.
Codex gets `mcp_servers.ace.tool_timeout_sec=660`; Claude gets `MCP_TOOL_TIMEOUT=660000`;
OpenCode 2.0.22 gets the remote server's `timeout.execution=660000`. These settings
come from the installed provider interfaces; Pi uses advertised `ace/timeoutMs`.
ACP defines no portable execution-timeout override. Its provider must permit the
advertised daemon deadline. SDK/CLI versions can still impose their own limits.
The ace ACP stdio bridge allows up to eleven minutes for tool calls.

Codex sends `mcp_servers.ace` with `http_headers.Authorization` in the native
`thread/start`, `thread/resume`, or `thread/fork` RPC configuration. The bearer is
absent from the app-server argv and shell environment. Claude's SDK HTTP MCP
configuration travels through a session-owned `--mcp-config` file: directory
0700, file 0600, outside the workspace, removed when its supervised process exits.
Pi reads the same private storage mechanism into its extension closure and deletes
the file-path environment variable before registering agent tools. Neither the Pi
MCP bearer nor its rollback control secret is inherited by shell commands.

ace's tool names are bare, and each provider prefixes them with the server
name `ace`. OpenCode shows `ace_context`; Claude shows `mcp__ace__context`; other
providers use their advertised ace server/tool prefix. Call `context` with topic
`status`, or read `ace://status`, to check availability. A disabled tool group does not imply
that ace is absent.

OpenCode also receives a credential-free native readiness plugin through its
runtime configuration. Session admission waits for the actual native
`ace_context` registration, because MCP connection status precedes the
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
  refs and takeover. `browser-agent-access.process.test.ts` uses a fake backend to show
  external sites open in every mode without a question, and private control refusing agents.
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
  slow click-origin hook races with injected time.
- `apps/daemon/src/screen-queued-cancel.process.test.ts`: cancelled input never
  dispatches after an earlier native action finishes.
- `packages/mcp-server/src/model-image.process.test.ts`: real local image encoder.

The harness uses temporary homes. It does not invoke installed provider CLIs,
record paid sessions, drive the user's OS, contact external sites, or use
`~/.ace`. Missing Chromium or ffmpeg produces an explicit test skip; no
automatic download occurs. Real OS permission and provider-version compatibility
remain separate installation checks.

## Performance verification at merge

`packages/browser/bench/text-wait.ts` is a localhost, temporary-home benchmark
for 100, 500 and 10000 nodes and an oversized 65537-character text node. It records
100 samples per case, p50/p95 wait latency, bounded-limit results and RSS. It has
not been executed under the owner rule. Measured latency and memory need run at
merge; the numerical limits above are implementation budgets, not benchmark results.

See [interaction smoothness measurements](interaction-measurement.md) for bounded screen/browser timing tools, repeat summaries and filmstrip interpretation.
