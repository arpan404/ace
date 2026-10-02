# 0040: Local usage and cost analytics

Date: 2026-10-02. Status: accepted.

## Context

The supplied competitor inventories report t3code's token/cost dashboard,
custom prices and pooled subscription limits. Claude Code exposes session
usage, and provider products expose their own subscription consumption.
Those inventories do not establish cross-provider account attribution,
whole-tree accounting, replay safety or timezone-aware daily history. They
are requirements references only. No competitor code is used.

ADR 0004's canonical `usage.updated` event currently includes input, output,
cache reads and optional dollars. `run.ended` has no usage. Recorded Codex
0.159.1 frames contain `tokenUsage.total` cumulative across samplings, alongside
`last`. Claude 2.1.286 repeats a message's usage across stream and assistant
frames, then reports aggregate usage at result. OpenCode 1.18.33 repeats the
same step-finish through SSE and sync envelopes. Counting every frame would
inflate consumption. Cursor's recorded ACP frames contain no usage.

## Decision

Add `@ace/usage`, a local SQLite projection with a pure counter normalizer,
versioned price JSON and bounded query APIs. A daemon-owned worker performs
all usage SQLite I/O. The committed canonical log is the only ingestion
source. Background replay advances a durable host-wide cursor in bounded
batches; live notifications only wake replay, so there is no growing live
queue. Cursor, counters, compact metadata, normalized increments and daily
rollups commit atomically. Restart repeats an uncommitted batch safely.

Each increment has one originating agent. Daily rollups retain thread, agent,
provider, account, model, workspace and billing mode. No ancestor receives a
second physical copy. Recursive indexed queries attribute a subtree to its
parent on demand, including usage recorded before a late parent link. This
makes ingestion independent of tree depth and keeps thread totals additive.
Cycles and cross-thread links are rejected. Unknown accounts/models remain
explicit null dimensions; provider metadata is never inferred from credentials.

A normalized increment ledger also records timestamps, enabling exact quota
window boundaries without pretending a daily bucket represents a five-hour
window. Accounts supplies read-only windows with unit, start/end, remaining
and optional limit through `QuotaReader`. Usage returns observed units/hour
and projected exhaustion. Percent-only provider quotas cannot be converted
to tokens and are not fabricated. Quotas remain accounts' responsibility.

## Counter and adapter contract

Add optional metadata to usage facts/events: reasoning tokens, cache writes,
model, account id, billing mode, counter mode and counter key. Input includes
cache reads and writes; output includes reasoning. These subsets are displayed
separately and never added a second time. Adapters normalize provider fields
before emitting facts. Cumulative counters use component-wise high-water marks
in a durable row keyed by agent and counter key. Decreases do not imply a new
session; adapters must namespace keys on session/message/step reset.

Codex emits `total`, cumulative under its native session key. Claude emits
message-scoped cumulative usage OR run-result totals, never both accounting
paths. OpenCode emits cumulative single-step counters keyed by step id, never
both step totals and assistant aggregate totals. ACP reports are explicit
incremental or scoped cumulative when supported. A true incremental report
has no counter key; retries at the canonical sequence are ignored. A keyed
incremental report is a once-only immutable sample. Unknown fields stay in
provider raw data; usage does not consume prompts or raw payloads.

For older events without metadata, Codex is agent-cumulative, Claude is
run-cumulative, and other providers are incremental. These defaults cannot
recover missing cache-write, account or session-reset information. Existing
fixtures validate this assumption, and the package documents the required
adapter enrichment. No provider CLI or recorder runs in this workstream.

## Prices and subscription semantics

The bundled JSON has a version, source URLs, and exact model ids with USD per
million input, cache-read, 5-minute/1-hour cache-write and output tokens.
Unknown models remain unpriced; there is no fuzzy model match. The initial
Anthropic rates come from [official pricing](https://platform.claude.com/docs/en/about-claude/pricing).
Codex counter shape is documented by [the app server](https://learn.chatgpt.com/docs/app-server)
and the recorded fixtures. Unsupported rates are omitted instead of guessed.
Settings can override exact model entries. Queries identify the table version
and separate provider-reported dollars, estimated dollars, unpriced tokens,
and subscription tokens. Subscription consumption never creates billed
USD, even when a CLI supplies API-equivalent dollars. Optional equivalent API
cost uses the table and is labeled separately. Unknown billing mode exposes
reported values as provider-reported, but does not invent an estimated bill.
Estimates use current query settings, so overrides apply to existing history
without rewriting provider-reported costs. They are comparisons, not invoices;
taxes, regional pricing, tools and tier modifiers need explicit overrides.

## Protocol and daemon additions

Add `protocol/usage.ts` and exports, plus additive wire members:

- `usage.summary { requestId, query }` returns bounded grouped totals. Group
  by any combination of day, thread, agent, provider, account, model and
  workspace; filter the same dimensions. Rank descending by tokens or dollars
  and set a limit to get top threads/agents. `agentTree` selects inclusive
  subtree attribution while the default agent groups show direct usage.
- `usage.series { requestId, query }` returns daily groups ordered by day.
- `usage.result { requestId, kind, result }` includes cursor, timezone, price
  version, rows, truncation and optional burn rate.

Dates are inclusive ISO local calendar dates. Queries are limited to 366 days,
1,000 rows, bounded ids and small filter lists. Pagination is not implicit;
truncation is explicit. The projection timezone is an IANA setting fixed at
creation, with the daemon defaulting to the host timezone. Changing timezone
requires rebuilding the derived usage database from retained events. DST
uses calendar dates through Intl, never a fixed 24-hour offset.

These read commands require authenticated read scope and use the existing
socket/outbox limits. They do not create command receipts or provider intents.
Daemon configuration accepts usage settings, separate from provider secrets.
Accounts integration is optional until that workstream lands.

## Security and performance

The projection stays in the private daemon directory and stores opaque ids,
model ids and numbers only. It never reads CLI credentials, prompts, source,
outputs or competitor implementation. Query column names come from a fixed
allowlist, values use bound SQL parameters and schemas validate boundaries.
The worker has bounded RPC count and bytes with rejection/backpressure. It
accepts compact pages, excludes raw data, and validates responses. SQL uses
prepared statements, indexed counters and one batched daily upsert per
transaction. Ingestion is O(change), with O(1) counter/metadata lookups per
event; no scans of event history. SQLite indexes and bounded result limits
serve queries. Subtree queries visit the selected tree; grouping all inclusive
agent totals costs tree depth times rollup rows and is deliberately opt-in.
Disk history grows with usage facts and distinct scopes; process memory stays
bounded by one replay batch and one query result. Backfill yields between
batches and tolerates events arriving while replay runs.

Non-gating benchmarks measure ingestion throughput, year-of-rollups query
latency and peak RSS. Gating tests have no wall-clock performance budgets.

## Verification

Use public APIs, temporary SQLite, worker restarts and real authenticated
WebSockets. Cover subtree and late-link attribution; fixture-derived provider
counters and retries; partial counters; midnight and both DST transitions;
reported/estimated/subscription/unknown costs; price overrides; all dimensions,
filters and top results; exact quota boundaries; resumable backfill; transaction
rollback; randomized streams against an independent raw recomputation. Kill
at least eight meaningful production mutations and record them with benchmark
numbers in the PR. Run the full repository check before delivery.
