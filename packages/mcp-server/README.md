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

`ToolRegistry.registerContent` accepts a Zod input schema and validates MCP content results at the boundary, including JPEG images. Rich results cap at 12 MiB, including base64 and JSON overhead. Structured registrations keep their 256 KiB result cap. `screen_*` names require the `screen` capability and `device_*` names the `devices` capability.

## Tool naming and annotations

Tool names are bare lowercase snake case: `context`, `delegate`, `thread_read`. The server is
named `ace`, and every provider already adds that namespace: Claude and Codex show
`mcp__ace__<tool>`, OpenCode and Pi `ace_<tool>`. An `ace_` prefix would only repeat it
(`mcp__ace__ace_context`). `bareToolName` (`@ace/provider-kit/ace-tool-names`) strips either
namespace; the registry resolves calls, approvals, the always-loaded set and toolsets by bare
name, so a toolkit that still registers an old `ace_`-prefixed name (`ace_browser_open`) reaches
the same tool as its bare spelling. New toolkits register bare names. Name a tool for what the
agent wants (`threads_find`, not `threads_list` plus `thread_search`), and merge siblings that
differ only by a flag into one tool with a field.

Every registration states `title` (defaults to its name in words), a risk class and, where it
matters, `destructive` and `openWorld`. Annotations follow: `readOnlyHint` from a read-only risk
class, `destructiveHint` only for tools that delete or overwrite work (today `thread_merge` and
`automation_remove`, the only ace tools Codex prompts for), `idempotentHint` for reads and tools
with a `requestId`, and `openWorldHint` only for tools that reach past this machine. Put actions
of different risk in different tools: annotations are per tool, so one destructive action would
make every call of its tool ask the person. Describe every field the model fills with
`.describe()`, and prefer enums to free strings. A tool declares the guide topic (`toolset`) whose
family it belongs to; the browser, screen and device families default by name, and a tool with
no family is always listed. The daemon attaches the screen toolkit when a screen manager is configured. Its handlers bind trusted thread/agent credential IDs to a human-delegated session, with no session selection in tool arguments.

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

The built-in `notify` persists a notification notice and intent.
`store.readMcpIntents(limit)` exposes a bounded page for notification and
orchestration consumers. After a consumer durably handles an intent, it calls
`store.acknowledgeMcpIntent(id)`. Delivery is at least once; consumers deduplicate
by intent id. Pending intents survive restarts. Bearers do not. Notices and
notification intents commit in the same SQLite transaction.

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

The adapters deliver guidance through Codex `developerInstructions`, Claude's
appended system prompt, OpenCode's native session instruction entry, Cursor's
always-applied rule in a private additional workspace, and Pi's
`before_agent_start` system-prompt hook. ACP has no portable system-instruction
field; ace supplies labeled guidance in native prompt context each turn.
Cursor's private rule carries no credentials and is removed when its SDK host closes.

Codex sends `X-Ace-Instructions: native` to omit MCP server instructions from
discovery. Its CLI otherwise copies server instructions into every description.
The same guidance is delivered once through its native instruction field.

The always-on guidance stays under about 300 tokens. It names situations and the
tool to reach for (`context` before work in an existing project, `delegate` for
parallel work, `browser_open` then a snapshot after a UI change, `thread_link_pr`
after opening a PR), says the agent's own tools are unaffected, and lists the guide
topics. Every tool name it mentions is checked against the served catalogue. The detail lives in the shipped skills
(`packages/plugins/builtin-skills`). Every provider with a native skill mechanism
lists them beside the person's own skills: Claude Code and Codex through a projected
plugin, OpenCode through its `skills` config paths, Pi through `--skill`, and Cursor
as copies in its private home's `.cursor/skills` (a skill the person has under the
same name wins). Every provider, ACP included, can read the same text with
`guide { topic }`; its result also lists the topic's tools from the live catalogue.
Every client lists `tools_find { query, limit?, family? }`, which ranks the tools this
session can call (`src/tool-search.ts`: stemmed words, a small synonym table, rarer words
weigh more) and returns each match's name, purpose, effect and input schema.
Claude Code and Codex defer MCP tools behind tool search; `context`, `guide`,
`delegate`, `wait`, `browser_open`, `html_render` and `tools_find` ask to load upfront.
OpenCode and Pi load every listed tool upfront and reload on `tools/list_changed`
(OpenCode 2.0.22 debounces a reload in `packages/core/src/tool/mcp.ts`; Pi's
extension re-registers), so their injections send `X-Ace-Tools: core` and list only
the entry points in `src/toolsets.ts` plus `tools_find`. Reading a guide, using a
family's entry point (`delegate`, `browser_open`, `screen_open_app`) or finding a
family's tools with `tools_find` adds that family's tools for the session and
announces a tool-list change; in core mode `guide` and `tools_find` also return the
schemas inline, so the next call needs no reload. Cursor's SDK (1.0.35) caches its
tool list and never handles `tools/list_changed`, and ACP leaves it to each agent, so
Cursor, ACP and Antigravity send `X-Ace-Tools: static` (the stdio bridge too): the
same core list plus `tools_find` and `tools_call { name, arguments }`, which runs any
ace tool through the exact path a direct call takes. `tools_call` is marked
destructive because it can reach destructive tools; it is offered nowhere else
(ADR 0082). OpenCode's own tools are named in
its session guidance (`packages/adapter-opencode/src/native-tools.ts`). Advertised input schemas omit bounds a
model never approaches (`$schema`, string lengths, safe-integer limits,
`additionalProperties: false`); calls are still validated against the full Zod
schema. `apps/daemon/src/mcp-agent-budget.process.test.ts` guards these budgets.

Disabled groups are absent from discovery and denied on direct calls. A group that is on
offers every tool at once, in every access mode: the provider's own permission mode, read-only
included, decides each call from the tools' annotations. ace adds no app or device approval.

Settings, turn boundaries and permission changes publish list changes.
Current clients receive them through `subscriptions/listen`. Native legacy HTTP
connections opt in with `X-Ace-Notifications: stream`; their bounded sessions and
GET notification streams end with the credential lease. Other legacy clients
retain stateless serving. ACP's stdio bridge relays current-protocol subscriptions
to legacy notifications. Pi refreshes its registered and active tools on changes.
Clients that do not consume notifications see current availability on their next
list request; direct calls always recheck it.

See [tool-list measurements](../../../docs/daemon/tool-list-measurements.md) for
before/after size estimates and the isolated reproduction command. Verification
uses fake provider processes and temporary stores, without real provider prompts.
