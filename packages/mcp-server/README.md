# @ace/mcp-server

The daemon's loopback MCP endpoint serves 2026-07-28 and legacy 2025 MCP clients.
See [ADR 0010](../../docs/adr/0010-ace-mcp-server.md) and
[provider injection contracts](../../docs/research/providers/ace-mcp-injection.md).

`startDaemon()` exposes `daemon.mcp.url` and `daemon.mcp.openSession(scope,
lifetime)`. Adapters open a lease after the canonical agent exists, inject its
bearer with the matching helper, and call `lease.end()` in their session exit
path. Aborting `lifetime` revokes the lease as well. Daemon close aborts all
leases. Never print a lease or the injection options.

`ToolRegistry.register` accepts a name, description, Zod object input/output,
capability or `null` for scoped reads, timeout and typed async handler. The
handler receives immutable credential attribution and an AbortSignal. Check
that signal before effects and pass it through all I/O. Failures return fixed
messages. Large data should live in owned artifact/output storage, with a
reference returned from the tool.

`ToolRegistry.registerContent` accepts a Zod input schema and validates MCP content results at the boundary, including JPEG images. Rich results cap at 12 MiB, including base64 and JSON overhead. Structured registrations keep their 256 KiB result cap. Names normally use `ace_*`; exact `screen_*` names require the `screen` capability. The daemon attaches the screen toolkit when a screen manager is configured. Its handlers bind trusted thread/agent credential IDs to a human-delegated session, with no session selection in tool arguments.

Annotate mirrored input parameters with Zod metadata such as
`z.string().meta({ "x-mcp-header": "Scope" })`. The current HTTP transport
validates `Mcp-Param-Scope` against the argument before execution and supports
the specification's Base64 encoding. `ToolRegistry.inputSchema(name, principal)`
provides the authorized prepared schema for the SDK's validation hook.

`Toolkit.register(registry)` is the extension point for browser, preview,
terminal, notification, orchestration and forge owners. Browser and preview
may use `registerAutomationTool` with a typed `AutomationAdapter`; image tools
use `registerContent`. Missing workstreams register no fake tools. Pass additional
toolkits through `startDaemon({ toolkits })`. Registration must finish before serving clients.

Built-ins read thread status and a page of agents, persist notification notices,
and accept spawn intents. Spawn acceptance means queued work, not a new running
agent. `store.readMcpIntents(limit)` exposes a bounded page for notification and
orchestration consumers. After a consumer durably handles an intent, it calls
`store.acknowledgeMcpIntent(id)`. Delivery is at least once; consumers deduplicate
by intent id. Pending intents survive restarts. Bearers do not. Notices and
notification intents commit in the same SQLite transaction.

The SQLite agent index participates in the event transaction, uses the existing
projection fold, and pages by agent id. Upgrading a database backfills only agent
events once. Reads never replay transcript history. Canonical agent/thread
statuses are returned unchanged, including waiting for humans and background work.

Defaults cap credentials at 1024, tools at 128, active tool executions at 64,
HTTP requests at 128, connections at 256, bodies at 64 KiB and results at 256 KiB.
The durable queue holds at most 10,000 pending intents. Excess work is rejected.
An uncooperative timed-out backend keeps its execution slot until it settles.
No MCP session replay or provider credentials are stored. The endpoint is never
registered with remote-access or relay routers.

Run `bun run --filter @ace/mcp-server bench` for lookup, dispatch and real-client
HTTP throughput. Run `bun run --filter @ace/daemon bench:mcp` for incremental
agent indexing, pages and atomic notification persistence. These measurements
are non-gating.

## Provider session composition

The daemon issues a new in-memory credential after the engine creates the thread
root, then supplies `SessionContext.aceMcp` to the selected account-bound adapter.
Closing, exiting, failed startup or engine abort revokes that credential. Adapters
scrub its exact bearer from provider payloads before persistence.

The current adapters use Codex app-server configuration, Claude Agent SDK
`mcpServers`, a session-owned OpenCode server configuration, and ACP session
`mcpServers` for Cursor, Antigravity and generic ACP. ACP HTTP support must be
advertised during initialization; an unsupported installed CLI fails with an
update hint. This does not establish support for the separate Cursor SDK adapter
or OpenCode v2 workstreams before they consume the same connection contract.

The offline provider tests use real child processes and authenticated loopback
HTTP without contacting a provider. They and the credential-redaction benchmark
need run at merge. No runtime tests, probes or benchmarks ran during this change.
