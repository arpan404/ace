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
There is no replay buffer or permanent MCP transport session map. A non-gating
benchmark measures credential lookup and dispatch throughput and peak RSS.

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
