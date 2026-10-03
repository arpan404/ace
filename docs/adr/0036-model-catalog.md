# 0036: Per-instance provider model catalog

Date: 2026-10-02. Status: accepted.

## Context

The competitor inventories in `/tmp/ace-orch/research-t3code.md` and
`/tmp/ace-orch/research-competitors.md` describe model pickers, effort controls,
Fast mode and multiple accounts. They do not establish a shared policy resolver
that settings, pickers and orchestration can use across all local providers.
Provider metadata varies by account and CLI version. A hard-coded global list
would offer unavailable choices and lose native tier IDs.

We read the inventories only for interfaces and behavior. Implementation is
written fresh from ace's requirements, provider research and primary protocols.
ADRs 0002, 0003, 0005, 0006 and 0007 still apply.

## Decision

Add `@ace/models`, with pure normalization and policy selection, and thin
process and persistence modules. Instances have opaque IDs and a non-secret
login revision supplied by the instance owner. Each instance supplies its own
executable, cwd, launch arguments and environment overrides. The catalog never
reads credential files, logs in or tests access through inference.

Discovery uses metadata only:

- Codex: initialize app-server, send initialized, page `model/list` with hidden
  models included. Preserve serviceTiers, defaultServiceTier, native model slug,
  supportedReasoningEfforts, default effort and inputModalities. Generated schemas
  from the installed binary confirm the shapes.
- Claude: CLI stream-json control initialization exposes its supported model
  aliases and metadata, as the SDK's supportedModels method does. Never send a
  user message. Missing capabilities stay unknown rather than being guessed.
- OpenCode: `models --verbose` exposes provider/model headings followed by JSON
  metadata. Preserve providerID/modelID, limits, capabilities and variants. No
  direct provider HTTP request or credential handling is needed.
- Cursor and the existing Antigravity profile: initialize, then create an
  empty session with no MCP servers, read model config options or legacy models,
  and stop the process. Cursor parameterized picker metadata is requested,
  with per-model options from `cursor/list_available_models` when supported. Only
  per-model options are attached to a model; current-session parameter options
  must not be generalized to every model.

### Proposed ACP registry amendment

The candidate implementation accompanying [ADR 0044](0044-acp-agent-registry.md)
defers model discovery for `provider: "acp"` until an already user-authorized real
session exposes selectors. Listing, stale reads and explicit model refresh do
not create an empty generic session or launch a process. No registry profile in
this change authorizes empty-session discovery. Native providers and the
existing Cursor/Antigravity metadata paths retain their behavior.

ACP cache generations include the source-qualified agent, immutable installation,
account instance, profile revision and login revision. Config selections retain
the actual config-option ID and native value; legacy selectors require profile
support. Session-derived replacements serialize per instance and wait for
pending login deletions. Shutdown waits for admitted persistence work. This
amendment remains proposed with ADR 0044 pending owner architecture review.

`--help` was checked for installed Codex, Claude, OpenCode and Cursor. No ACP
binary for Antigravity is installed here, so its behavior is grounded in
`docs/research/providers/antigravity.md` and fake protocol servers. Primary
references: [Codex app-server](https://developers.openai.com/codex/app-server),
[Claude SDK](https://platform.claude.com/docs/en/agent-sdk/typescript),
[OpenCode CLI](https://opencode.ai/docs/cli/),
[Cursor ACP](https://cursor.com/docs/cli/acp), and
[ACP config options](https://agentclientprotocol.com/protocol/session-config-options).

The normalized model includes id, display name, provider, instance, native
provider/model IDs, known context window, efforts, tiers with native selection
parameters, input modalities, default/hidden/deprecated flags and bounded raw
JSON. Unknown metadata is retained in raw data. Known malformed fields reject
an entire refresh, leaving the last valid catalog intact. Listings are reported
choices, not a guarantee of account entitlement.

Cache instances separately in an ace-owned SQLite file. Load once at startup;
replace an instance atomically after validation. Startup reads use SQLite
directly; later writes run on a dedicated worker so filesystem I/O does not
block the daemon event loop. The worker queue is capped at 128 requests. Default TTL is 15 minutes;
stale entries return immediately and trigger one refresh. Failed refreshes keep
stale data with a sanitized error and a short retry cooldown. Explicit refresh
bypasses cooldown. Login revision changes delete old rows before discovery;
late responses from the previous generation cannot repopulate the cache.
Requests for the same generation share one flight. Removal hides choices in memory immediately, but durable removal is confirmed
only when its awaitable result succeeds. It reports persistence failures. Failed deletions remain in a bounded queue until
an explicit retry, a refresh for the same instance, or shutdown succeeds.
Shutdown rejects if deletion still fails and keeps storage open for retry. Discovery has a deadline
and abort signal. A hung instance never delays reads of any other instance.
Shutdown waits for discovery resource cleanup as well as cancellation responses.
Injected discoverers must settle after abort once their owned resources are gone.

`list({ provider?, instance?, offset?, limit? })` returns a bounded page plus
per-instance freshness, error and refresh status. `resolve(roleSpec)` selects a
concrete model and compatible effort/tier, reports freshness and explains the
choice. Explicit IDs never silently fall back. Strongest uses the policy's
ordered model preferences, with duplicate IDs keeping their first rank.
Resolution explanations are capped at the wire schema's 1,024 characters while
the concrete selection fields remain complete. There is no defensible universal quality score in
provider metadata. Without an order, use the provider's default and state this
fallback in the reason. Deprecated and hidden models are excluded from automatic
selection. Unsupported required effort, tier or image input produces an error.

## Protocol and daemon additions

Add schemas in `packages/protocol/src/models.ts` and exports. Add correlated
`models.list`, `models.refresh` and `models.resolve` wire requests and
`models.result` replies through the existing authenticated socket. These are
catalog queries, outside the event-log command receipt transaction. Refresh is
idempotent and coalesced. No provider launch configuration arrives over the wire.
The daemon accepts a catalog interface so account/settings work can register
instances and call loginChanged without coupling this package to their storage.
The CLI opens the persisted catalog; account registration is a local API.
After merging remote access, list/resolve require read scope and explicit
refresh requires operate scope. Tickets and local admin authentication keep
using the existing remote-access checks.

## Security and resource limits

Only the user's local logged-in CLI reaches providers. Launch environment stays
in memory and outside persistence and replies. Raw metadata is recursively
redacted for credential-shaped keys, then capped at 2 KiB per model with an
explicit truncation flag. Errors are fixed codes, never provider stderr.

Cap instances at 64, models at 512 per instance, metadata output at 4 MiB per
probe and raw data at 2 KiB per model. A normalized model row is limited to 8 KiB,
so a 100-row wire page remains below 1 MiB. Persisted instance rows are capped
at 4 MiB. Refuse over-limit refreshes instead of silently presenting incomplete
results. Bound concurrent probes, pending wire
queries and pagination. Process owners stop probes on timeout, replacement and
shutdown. Retain at most 64 unsettled discovery cleanup promises and 128
pending deletions. OpenCode output is parsed incrementally, retaining only the
current native object and validated normalized rows. SQLite writes touch only the changed instance; prepared statements
are reused. Cached reads use instance/provider indexes and slice only the
requested page. Resolution walks compatible rows once without constructing a
full intermediate model list; it is not on stream-delta paths. Benchmark cached listing and policy resolution in
`packages/models/bench` and report throughput and peak RSS in the PR.

## Testing

Use real temporary SQLite files and fake executable CLIs/app-servers. Replay
recorded discovery payloads from fixtures where available, particularly Cursor
session configuration. No recorder and no prompts are used. Inject clocks and
deadlines to test TTL, immediate stale reads, retry cooldown, single flight,
provider timeout isolation, login changes during refresh and shutdown. Test
normalization, pagination, raw redaction/capping, malformed boundaries, model
policy choices and the authenticated daemon wire API. Apply at least eight
production mutation cases for the merge gate. The owner's latest policy defers
tests, mutation runs, benchmarks and `bun run check` until merge. Development
verification uses fmt, lint, typecheck and check:size only.
