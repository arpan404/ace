# 0051: Thread forks, context merges and turn-boundary switches

Date: 2026-10-02. Status: accepted.

## Context

Forks branch completed history, including failed, interrupted and quota-limited
runs. They are independent threads, not live subagents owned by the source.
Treating lineage as execution ownership would violate ADR 0004. Changing a
provider loses its private working state; changing its model must preserve it.

The [Orchestrator V2 release notes](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)
were read only as a feature inventory. No competitor source was read.
The ADR was the first deliverable. It was initially numbered 0050, then moved
to 0051 after the parallel Pi PR reserved 0050. Number 0051 is above the highest
ADR on origin/main and in open PRs at final selection.

## Decision

Add schema-only fork points, lineage, handoff manifests, execution selections,
switch state and commands in `@ace/protocol/thread-transitions`. Thread and root
agent expose lineage separately from `parentId`. The event log and snapshots
retain lineage and switch fidelity for clients.

The engine owns durable transition intents. A fork opens a new native session
with a source native ID and exact supported boundary. Capability flags decide
whether that boundary supports native forking. An adapter may declare a full-session end boundary for the latest finished run.
Unsupported older points use portable handoff; a native operation failing is reported, never silently downgraded.
Finished runs of every outcome are eligible, even when the source has later live
work. Full-session end forks require quiescence; explicit finished boundaries do
not stop the source. Subagent points use their native session only when the
adapter declares that contract, otherwise portable handoff. Live descendants,
interactions, tools, tasks, provider queues and unacknowledged sends prevent
switches and patch merges.

`@ace/handoff` owns the pure budget and selection policy. Selection prioritizes
recent complete items, keeps chronology, tags every excerpt with source IDs,
and reports counts and paging pointers for everything omitted. Selection never
exceeds its encoded byte budget. The daemon reads bounded pages, not an entire
conversation. Cursor can import the same package for portable forks.
Scoped MCP tools expose pages and bounded text/output chunks. Durable grants
retain the selected cutoff after prompt delivery; unrelated histories remain
outside the recipient's scope. Grants have an explicit per-recipient cap.

A merge supplies a human/agent-authored summary with validated citations into
the fork. It becomes a synthetic context message in the source and is delivered
on its next turn. Optional bounded patches use `GitService.applyPatch`; applying
a patch requires both trees to be quiescent. No summarizer prompt is sent by the
daemon. Context is quoted as external conversation, not system instructions.

Switch commands persist one replacement selection per thread. The current turn
continues. Before the next queued send, the engine waits for whole-tree
quiescence and applies the pending selection. Model/options changes configure
the live session when supported, otherwise native resume preserves the session.
Across providers, create a new session with portable context and expose `lossy`
and `delegate_task` advice. Remember model/options per provider and model in
SQLite, with bounded selection cardinality. Account changes close the source
session, call the accounts migration service, then native resume. Migration
refusal preserves the old selection and emits a visible failure. The accounts
lease policy remains authoritative; ace cannot promise external-writer exclusion.

## Consequences

Native forks retain provider-private history. Item boundaries unsupported by a
provider are explicitly portable and lossy. Clients can show ancestry without
making source status depend on an independent fork. Queued switches survive a
restart; uncertain native fork delivery is not replayed automatically.

Transition metadata and prepared lookups are bounded or durable in SQLite.
A transactionally maintained blocker index checks readiness without loading historical agents. Delta handling performs no transcript scan. Handoff construction is a cold
operation over at most 200 items and 1 MiB of excerpts. One transition runs per
thread, with the engine's existing capacity and serialized intent worker.

## Validation

Write public behaviour tests with fake adapters and temporary SQLite/git edges
for native/fallback forks, terminal outcomes, merges, queued switches, unchanged
session IDs, account migration, remembered options, restart and tree lineage.
Write budget/provenance tests and a non-gating handoff benchmark. Under the
owner's current rule, tests, mutations and benchmarks are not executed before
merge. Static type, lint, format and size checks are the development checks.

Primary contracts: [Codex app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md),
[Claude SDK sessions](https://platform.claude.com/docs/en/agent-sdk/sessions),
ADR 0007 and ADR 0018. Provider extensions remain capability-gated while the
OpenCode, Pi and Cursor workers finish their adapter changes.
