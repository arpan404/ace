# @ace/adapter-claude

Claude Code's local CLI through official Agent SDK 0.3.288. The adapter always
sets `pathToClaudeCodeExecutable` to the discovered user's executable. Upgrading
the wrapper does not upgrade or substitute that executable. ace never calls SDK
authentication mutation APIs. The fixture-backed floor remains CLI 2.1.286.

```ts
import { createClaudeAdapter, isolatedConfiguration } from "@ace/adapter-claude";

const coding = createClaudeAdapter({ executable: "/path/to/claude" });
const isolated = createClaudeAdapter({
  executable: "/path/to/claude",
  configuration: isolatedConfiguration,
});
```

Normal coding explicitly selects the `claude_code` system-prompt preset,
`permissionMode: "default"`, and `user`, `project`, `local` settings sources.
Settings can load local hooks, plugins and MCP servers. Hosts can select a
subset and an explicit permission mode through `configuration`. Isolation uses
no settings sources and strict MCP configuration. Discovery always uses
isolation, an empty MCP set and an open streaming input with no user message.
Neither mode authorizes authentication management.

## Session and shared owners

`openSession` initializes a long-lived streaming Query. `send` uses UUID-stamped
`priority: "next"` input. Steering still rejects and `steer` remains false.
The provider-kit bridge owns the process group, forwards unknown controls/raw
messages, and applies stdout backpressure and a 16-MiB frame limit. Pending input
and interactions reject excess admission at 256 entries; human waits have no
local timeout. Process termination expires pending asks, while native withdrawal
cancels them. The first valid answer wins.

Permissions keep native title, description, decline-default and suppression
flags, MCP source, request/tool/child correlation, and the complete update set.
The single grant option labels each destination and returns the entire set.
Suppression removes that option and rejects forged grant answers. Unknown
destinations remain raw metadata and do not produce misleading grant choices.

Form and URL elicitation map to canonical `elicitation` interactions. Typed MCP
answers are validated before settlement, and invalid answers leave the request
pending. A URL is displayed as provider content, not consumed as a login flow.
No user-dialog kinds are advertised; unsolicited unsupported dialogs cancel.
Neutral SubagentStart/Stop hooks retain native child identity/transcript-path
facts as raw events. Hook inputs do not create agents or settle child work.

`ClaudeOptions.mcpServers` accepts the existing owner's `claudeInjection(...)`
result. `ProviderSession.mcp` exposes status, replacement, reconnect, enable and
disable controls to configuration owners. It does not create a registry or edit
`.mcp.json`. Replacement affects the SDK dynamic set. Settings/plugin servers
remain CLI-owned. Returned connection failures reject visibly and wire control
results, including extensions, remain raw. Optional controls fail through the
installed CLI's error response rather than assuming wrapper presence proves
support. The daemon's accounts/configuration owners can consume these ports;
this branch adds no duplicate account or command service. Daemon discovery now
binds each Claude Query to the existing MCP service's scoped ace lease. The
service keeps that lease in SDK replacements and exposes authorized
`mcp.status`, `mcp.replace`, `mcp.reconnect`, `mcp.enable` and `mcp.disable`
requests through its own socket registration. Controls expire with the process.
Daemon hosts pass their account observer as `DaemonOptions.claude.onRateLimit`;
it receives the thread identity and native observation. No accounts package is
introduced here.

The existing MCP discovery owner can read the same session:

```ts
import { claudeDiscoveryApi } from "@ace/mcp-server";
if (session.mcp) {
  const controls = session.mcp;
  const discovery = claudeDiscoveryApi({ mcpServerStatus: () => controls.status() });
}
```

`ClaudeOptions.onRateLimit` delivers parsed stable rate-event metadata to the
accounts owner. Reset times remain native epoch seconds; utilization remains a
native ratio. Extensions and overage fields survive. Observation errors are
reported without killing the provider. There is no production polling of the
unstable SDK usage method. An allowed bucket only clears its own rate block and
cannot clear a later network retry.

## Accounting and queued work

Main-loop `result.usage` produces keyed, incremental agent accounting. Input
counts include cache read/write tokens. Child assistant usage remains attributed
to the child with deduplicated cumulative message refinements. Inclusive
`modelUsage` and `total_cost_usd` produce separate `model_session` and
`provider_session` snapshots. They are estimates and never add to agent/day
rollups. The usage owner's `sessionTotalsFor({thread,limit})` reads up to 100
snapshots; `UsageWorker` exposes the same operation. Repeated/lower snapshots
cannot erase stored totals. Resume/fork inherited snapshots remain separate
from fresh per-turn activity, and conversation resets start a new counter key.
Canonical replay retains the scope and omits malformed legacy
snapshot identities visibly while continuing healthy ingestion. Thread views
and materialized reconnect snapshots keep `usageSnapshots` separately from
per-agent `usage`; clients select them through `usageSnapshot(key)` and the
projection owner's `usageSnapshotKey`. An authorized `usage.session_totals`
request reads the inclusive estimates from the daemon worker.
Known startup failures emit no accounting sample. Root and child samples carry
cache-write totals and their native one-hour subset, including refinements, so
ordinary, cached, five-minute and one-hour inputs receive their own prices.
Native result UUIDs and a
bounded 256-result window suppress duplicate settlement; supported native result
indices provide a monotonic guard. Historical raw fields remain available.

When initialization advertises `interrupt_receipt_v1`, wire-ordered receipts
retain known UUID survivors until a correlated result consumes them. Internal
unknown UUIDs do not become ace sends. Missing receipt/count fields are not
proof that queued work or background tasks finished. Root interruption never
settles children. Consuming the final known survivor publishes an empty queue
even without a count field. An authoritative zero count retires an overflow
correlation guard; independent background work remains unfinished. Older CLIs
without receipt capability use the existing queue fallback and do not accumulate
unsupported UUID correlations across ordinary turns.
Explicit cascades attempt every registered target and report
aggregate failures. No private `cancelQueued` API is used.

## History and model discovery

`forkClaudeSession({nativeSessionId,home,configDir?,signal})` runs the official
filesystem helper in a short-lived Node process whose HOME/CLAUDE_CONFIG_DIR
belong to one account. It clones history while idle, validates a fresh UUID and
never starts a provider turn. It preserves the source transcript. It does not
clone git worktrees or file-undo snapshots. An adapter constructed with an
explicit `env.HOME` supplies the optional shared `forkSession` port; the history
continuation owner uses that port when its own fork override is absent. Existing
history storage owns native identity and lineage. Global daemon homes never
change. `fork` remains false until the new isolation test runs at merge and
owner-approved recordings establish the live contract.

`discoverClaudeModels` exposes initialization-only `supportedModels()` through
this package's public API. Models uses this operation and its existing
`normalizeClaude` envelope instead of raw initialization parsing. The process
bridge is also publicly exported. Discovery respects the catalog's injected
cancellation, caps metadata output at 4 MiB and closes/stops in `finally` on
success, malformed metadata, cancellation or startup failure.

## Verification gates

Existing fixtures retain partial/complete transcript correlation, late child
identity reconciliation, task/wake grace windows and conservative unknown work.
New public adapter/translator/usage tests cover SDK controls, duplicate answers,
expiry, permission destinations, multiple result scopes, clear/startup accounting,
interrupt survivors, fork homes and discovery cleanup. Process-spawning tests
use `*.process.test.ts` and synthetic CLIs or isolated local transcript files.
Incomplete tool argument JSON remains raw until a completed assistant tool block.

Tests, mutations, provider probes and benchmarks were not executed in this task.
They need run at merge. `bench/sdk-controls.ts` adds a non-gating public translator
workload for the new queue/accounting path; ops/s and peak RSS are unmeasured.
See [recording scenarios](recording-scenarios.md) and [mutation cases](MUTATIONS.md).
No fixtures were recorded, no real prompt was sent, and no new capability was
advertised. ADR 0046 remains proposed. Qwen daemon SDK adoption is follow-up work;
Gemini and Qwen's current ACP paths stay with their registry owner.

## Review follow-up limits

Child accounting admits at most 256 ledgers and 1,024 distinct messages per
ledger. Retained message refinements remain idempotent. Excess samples produce
one visible accounting-capacity warning and remain raw, rather than inflating
totals after an eviction. Counts saturate at the safe-integer ceiling.
Session control bookkeeping retains at most 512 live tasks plus needed ancestor
records within that same cap, and 1,024 unsettled tool parents. Completed leaves
and their unneeded ancestry retire incrementally. A 512-entry compact ancestry
window correlates descendants whose metadata arrives after completion. If an
explicit cascade reaches ancestry outside that window, it reports uncertainty
while still stopping known descendants. Excess live admission ends
the provider visibly; live control identity is never silently evicted.
Other existing translator identity caches are unchanged by this follow-up;
these limits do not claim that every inherited translator cache is bounded.

`bench/sdk-controls.ts` now includes 1,024 retained child messages and duration
refinements. `bench/session-retention.ts` covers completed-task churn, and
`packages/projection/bench/usage-scopes.ts` covers 64-model snapshot folding.
All throughput/RSS evidence needs run at merge; no benchmark was executed.
