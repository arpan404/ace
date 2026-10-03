# 0043: OpenCode v2 through the installed CLI and official HTTP client

Date: 2026-10-02. Status: Proposed.

## Context

ace's OpenCode research and recordings target 1.18.33. The adapter on
`integration/train-1` rejects CLI major 2 and uses the v1 launch text, HTTP
routes, event envelope, message parts and question replies. The installed CLI
is now 2.0.22. Its `/doc` and removed legacy routes return HTML; its OpenAPI is
at `/openapi.json`, and its native stream is `/api/event`.
The [v2 research](../research/providers/opencode-v2.md) and
[GET-only probes](../research/providers/opencode-v2-probe.md) establish these
changes without model turns.

The official packages also changed names. `@opencode-ai/sdk/v2` remains an
entry point of the legacy 1.18.34 package. The matching major-2 network client
is `@opencode/client@2.0.22`; the new `@opencode/sdk@2.0.22` embeds the runtime.
Its embedded host would replace the user's installed CLI and introduce Effect.
The source and npm citations are in the research's SDK section.

ADRs 0002, 0003, 0004, 0005 and 0007 remain binding. Providers run through
locally installed tools under the user's login, status comes from the whole
agent tree, decision logic stays pure, and recorded provider behavior is
versioned evidence. The official client does not replace ace's responsibilities.

## Proposed decision

### Version policy

Replace live v1 execution with a v2 adapter. Start with 2.0.22 as the verified
baseline, and require a matching server identity plus required operations from
the installed server's OpenAPI. Reject v1 with an upgrade instruction and
unknown majors with an unsupported-version result. Extend the v2 support
range only when capability probes and behavior evidence support it.

Retain v1 fixtures and research as historical evidence. Do not reinterpret
v1 frames as v2 recordings or claim they certify the new adapter. Import
legacy history through the installed CLI's projected HTTP history, when
available; ace does not migrate OpenCode's database itself.

### Official client and owned process

Pin `@opencode/client@2.0.22` and use its public Promise root and generated
operation types. Keep a small adapter transport module around `OpenCode.make`
with injected fetch, cancellation and raw HTTP/SSE observation. Validate
external values leniently with Zod and keep bounded unknown raw data. Generated
TypeScript output types are not runtime validators.

Use `@ace/provider-kit` to discover and own the user's executable. Default to
one loopback server per adapter instance, shared by its ace sessions:
`opencode serve --stdio --hostname 127.0.0.1 --port 0`. Inject an ephemeral
`OPENCODE_PASSWORD`, keep stdin open, parse JSON readiness, and validate
`/api/info` and `/openapi.json`. Never log transport credentials. The server
uses the user's normal OpenCode configuration and login. ace never accesses
provider credential APIs/files, initiates login or offers a hosted endpoint.

Do not adopt legacy `createOpencode`/`createOpencodeServer` or the new embedded
`@opencode/sdk`. The former uses incompatible readiness/API contracts; the
latter bypasses the installed CLI. Do not use `Service.ensure` by default,
because it can stop and replace the user's shared service. Existing local
server attachment may be offered explicitly with read-only discovery and an
external-owner lifecycle policy; disconnect must not kill that server.

### Facts, interactions and background work

Translate native `type/data/location` events into the existing canonical
facts. Execution lifecycle closes turns; provider response or step completion
does not. Recover projected idle markers and execution outcomes without
creating duplicate turn ends. Preserve structured retry/error and usage data.

Build child-agent edges from verified `parentID` and `subagent` tool metadata.
Keep fork lineage separate through `Session.Info.fork`. Track native background
shells by verified owning session and shell ID. Root completion cannot settle
a thread with a live child, shell, pending interaction, undelivered input or
expected completion wake.

Use the session-scoped permission and form routes. Map known question forms
without losing keyed fields or multi-select answers. Preserve unknown form
kinds, and do not distribute global MCP forms to arbitrary threads. Expose
`always` as a saved project grant. Do not expire pending interactions merely
because SSE disconnected; reconcile them against the same server. Expire on
confirmed process/location loss or evidence that the request no longer exists.
Plan review and interrupt cascade capabilities require v2 evidence.

### Recovery and limits

Keep ace supervising process lifetime, stream EOF/errors, stalls, malformed
frames, overflow, reconnect and recovery barriers. The client's shared SSE
queue is bounded but has no reconnect or state reconciliation. Heartbeats
are 15-second SSE comments; use the client's transport activity callback
and an injected silence policy.

Reconcile owned session trees, projected messages, active execution IDs,
permissions, forms, inbox items and running shells. Apply newer work before
idle snapshots, preserve bounded raw unknown-child evidence until ownership
is proved, and ensure unrelated projects cannot extend recovery or consume
its per-thread buffer. Use durable aggregate sequences for gap detection,
without counting ephemeral events as sequence gaps.

The stock CLI does not enable retained event payloads by default. Its log
route and durable sequence fields therefore do not guarantee replay. Snapshot
recovery is mandatory; log replay is supplemental only after retention is
established for the actual server. Failure to establish completeness leaves
the thread disconnected or unresponsive, never falsely done.

## Alternatives

Supporting v1 and v2 live would preserve separate translators, launchers,
interaction contracts and recovery paths. It adds ongoing correctness work
without fulfilling the owner's request to move to v2. Keep the old evidence,
but do not maintain dual execution by default.

Using only bespoke HTTP would duplicate serialization and types already
provided by the matching official client. Adopt the client where it fits;
keep ace-specific ownership, validation, byte limits and recovery around it.

Embedding OpenCode would avoid a child-process launch, but would violate the
installed-CLI decision and couple ace to OpenCode's runtime and Effect.

## Consequences and rollout

The adapter migration also touches provider-kit version/auth discovery and
the model catalog: the v2 version prefix and CLI metadata formats changed,
and `models --verbose` is gone. These changes belong in their existing owner
modules rather than duplicate adapter implementations.

Author behavior tests against local fake HTTP/SSE servers for recovery,
ownership, tree status, interactions, native background shells and queueing.
Request owner approval before recording any v2 model fixtures. The research
contains the scenario list and the implementation brief is
`/tmp/ace-orch/impl-opencode-brief.md`. Recordings and confirmation of uncertain
capabilities are release gates. This docs-only proposal does not authorize
fixture spend, run tests or change feature code.
