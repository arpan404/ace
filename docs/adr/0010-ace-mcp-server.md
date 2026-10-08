# 0010: One daemon MCP toolset for every provider

Date: 2026-10-02. Status: accepted.

## Context

The competitor inventories in `/tmp/ace-orch/research-t3code.md` and
`/tmp/ace-orch/research-competitors.md` describe browser automation over MCP,
provider-specific injection, and scoped session credentials. t3code's browser
automation depends on a desktop automation host. Cursor proxies cloud MCP;
Claude and Codex expose tools through their own clients. These interfaces do
not give ace a common, attributed toolset across local providers. These notes
inform requirements only; no competitor implementation is reused.

ace needs the same notification, tree inspection, orchestration, browser and
preview contracts regardless of which logged-in CLI runs an agent. A tool
must never select its caller's thread or agent from untrusted arguments.

## Decision

Add `@ace/mcp-server`. The daemon owns a separate ephemeral-port listener on
`127.0.0.1`, at `/mcp`. This keeps the endpoint out of LAN and relay routers
without changing the WebSocket server. Provider adapters receive its URL and
a session lease, and must end the lease when their provider session ends.
The lease also binds to an injected session AbortSignal. Shutdown revokes all
leases. Restart creates an empty registry; no credentials survive.

The current published spec is [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28).
It uses per-request version metadata and `server/discover`, without a handshake.
Serve it alongside the legacy 2025-11-25 initialization handshake that installed
CLIs still use. Use the official TypeScript SDK's current split packages
`@modelcontextprotocol/server` and `@modelcontextprotocol/node`, with its client
in integration tests. The older monolithic `@modelcontextprotocol/sdk` is v1;
it cannot satisfy the current revision. The split SDK supports Node >=20 and
Zod 4 and ships compiled JavaScript, so ace's Node 24 erasable-source rule holds.
Accept these MIT dependencies. We delegate protocol framing, discovery,
legacy negotiation and cancellation to the SDK instead of maintaining a fork.
Return an SDK `McpServer` with its schema lookup bound to the registry's prepared
input schemas. The SDK then validates advertised `x-mcp-header` parameters
before dispatch, including Base64 decoding, and rejects missing or mismatched
headers with HTTP 400 and JSON-RPC `-32020`. Looking up one schema does not
register or scan the entire toolkit on each request.

## Contracts and wire additions

Add schema-only MCP capability, attribution, notification and spawn intent
schemas in a new protocol file. Existing event and WebSocket unions stay intact.
Tool schemas are Zod objects with typed handlers, required capability, timeout,
and AbortSignal. The registry validates input and output and exposes only tools
the caller can use. Read-only thread inspection needs no extra capability.
Capabilities are `browser`, `preview`, `terminal`, `notify`, `agents`, `forge`.

The built-ins are `ace_notify_user`, `ace_thread_info`, `ace_list_agents`,
and `ace_spawn_agent`. Notification acceptance must persist the notice and
notification intent together through a host port. Spawn acceptance returns an
intent id, never claims an agent has started or completed. The orchestration
workstream owns execution and its state transitions. Thread and agent reads
use bounded pages, preserve canonical status, and never recompute tree status.

Browser and preview workstreams register tools through typed toolkit adapters.
Missing backends expose no fake-success tools. Terminal, notifications,
orchestration and forge use the same public registry contract.

Pure injection helpers return Codex `-c` overrides plus a token environment
variable, Claude Agent SDK `mcpServers`, OpenCode runtime config content, and
ACP HTTP server definitions for Cursor and Antigravity. Each includes short
developer instructions. Provider research records the exact accepted shapes.
Discovery reads bounded config files or injected read-only API ports, returns
server names and redacted transport metadata, and never writes user configs.
Claude's project `disabledMcpServers` opt-outs apply across discovered scopes.

## Security and lifecycle

Generate 256-bit random bearer secrets at the I/O boundary. Store only SHA-256
digests mapped to immutable thread/agent/session scope. Never log requests,
headers, raw tool errors or bearer material. Require authentication on every
HTTP method. Validate Host and Origin before protocol handling to prevent DNS
rebinding. Credentials are ace-local capabilities, not provider credentials;
they are handed only to the user's CLI process and never persisted in config.

Revocation synchronously removes authority and aborts in-flight work. Tools
must honor cancellation before effects and pass the signal into their I/O.
Timeouts bound server occupancy even if a backend ignores cancellation; an
uncooperative backend may still finish its I/O, so acceptance ports must check
the signal before committing. Errors exposed to providers use fixed messages.

## Performance and bounds

Credential and tool lookup are O(1). Cap credential count, tools, HTTP bodies,
active requests and active tools. Reject excess work without queues or eviction
of live authority. Index session cancellation through its lease; no history
scan occurs on tool calls. Compile JSON schemas at registration. Limit results
and discovery inputs, and stream HTTP through the Node SDK bridge. MCP control
messages are bounded JSON; large browser/terminal artifacts use references.
Open discovery configs nonblocking, inspect the opened descriptor, and read
only regular files. This prevents a FIFO from retaining a filesystem worker
while waiting for a writer, without introducing a stat/open race.
There is no replay buffer or permanent MCP transport session map. A non-gating
benchmark measures credential lookup and dispatch throughput and peak RSS.

The server's mandatory `ace_status` discovery tool uses a separate registry capped
at one tool and 64 active reads. `maxTools` continues to bound the caller's backend
registry, including registered toolkit built-ins; starting the HTTP server does
not consume or increase that capacity. Status resources and tool descriptions use
the same scoped reader. The existing HTTP request limit bounds both registries.

## Testing

Use real loopback HTTP with official MCP clients for current discovery and the
legacy handshake. Test capability filtering and denial, session revocation,
caller attribution, concurrent tools, cancellation, timeout, schema failures,
capacity limits, hostile origins and malformed/oversize requests. Inject time
for timeout tests and use explicit barriers for concurrency and cancellation.
Test injection shapes against the provider research and discovery against
temporary config files and read-only API fixtures. Run the repository check
and kill at least eight meaningful mutations before delivery.

## Consequences

The daemon can start MCP before orchestration exists. Its default read adapter
uses stored canonical views; write toolkits require explicit host ports.
Provider adapter workstreams must wire session leases into their lifecycle and
apply these helpers. Browser/preview and durable notification/orchestration
consumers remain owned by their workstreams, with no substitute execution here.

## Amendment: OpenCode native tool readiness

The isolated [OpenCode 2.0.22 probe](../research/providers/opencode-ace-tools.md)
shows that native model tools can lag a successful MCP connection. Add a
credential-free Promise plugin to the owned CLI's runtime plugin list. Observe
its native tool transforms and await a bounded, cancellable readiness RPC
before accepting the session. Keep remote MCP registration, scoped authority
and redaction in the existing adapter. Stage the plugin with standalone
releases. No Effect dependency is introduced into ace, and no credentials
enter the plugin or its readiness RPC.

## Amendment: native guidance and changing availability (2026-10-07)

Capabilities on a lease are an immutable ceiling. Runtime enablement, read-only thread mode and app grants further restrict both discovery and execution. Disabled screen/device groups are absent; enabled screen initially exposes only `screen_request_app`. `ace_status` explains unavailable groups. Browser computer use requires a person's turn/thread grant in ace's UI, never an Always grant or an agent-initiated approval.

Deliver guidance through each provider's native instruction mechanism. Codex opts out of MCP discovery instructions with `X-Ace-Instructions: native` because it otherwise prefixes every tool description. Cursor loads an always-applied rule from a private temporary additional workspace rather than replacing its system prompt. ACP has no portable system-instruction field, so its native prompt carries labeled guidance context.

Advertise `tools.listChanged`. Current clients subscribe through the SDK notification API. Native legacy clients opt in with `X-Ace-Notifications: stream`, retaining at most 128 temporary HTTP transport sessions, tied to the authenticated lease identity and closed on revocation/shutdown. Other legacy traffic remains stateless. This extends the original no-permanent-session-map contract with a bounded in-memory stream lifetime; there is still no replay buffer or persisted transport state. The ACP stdio bridge forwards notifications and Pi refreshes its active extension catalogue while preserving native tools.
## Native Sources and user controls

Thread Sources reads enabled ace groups through the same discovery filter as the MCP endpoint.
Provider inventories expose names and normalized connection states only. Claude Code controls
use its live SDK handle; Codex uses MCP status, native config writes and reload; OpenCode uses
location-scoped MCP registrations and connect/disconnect. Ending a provider session removes its
control handle. Controls require thread read or operate authority as appropriate.

Explicit Add server accepts a name and command/arguments or a non-secret HTTP URL. Claude and
Codex persist through their own config mechanisms; OpenCode's current API registers for the
session. Environment variables and authentication headers must be configured in the provider.
ace neither reads that config nor stores it. The service-owned ace connection cannot be replaced
or disabled by these controls. Codex reload changes apply on its next turn.
