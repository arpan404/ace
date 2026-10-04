# 0062: Long-thread data APIs

Date: 2026-10-03. Status: accepted.

## Decision

Persist a turn index alongside canonical event writes. Reuse the stable root run ordinals from ADR 0057. User messages received before a run belong to that next turn; automatic runs also receive an ordinal. Keep item-to-turn and agent-to-turn ownership durable so late background results update their original turn. A root run ending is an outcome fact, not proof that its tree has finished. Turns remain active while their agents, tools, interactions or background tasks are live. Current thread status and its reason always come from the whole-tree status owner in ADR 0004.

`turns.page` returns bounded summaries in ordinal order, with exclusive ordinal cursors and a 1 MiB wire budget. A page may contain fewer turns than requested. Each summary contains times, canonical sequence bounds, initiating-message preview, outcome and deterministic digest. Digests count tools by kind, changed files and known added/removed lines, commands and failures, approvals asked/answered/auto-reviewed, subagents and token usage. Auto-review is an explicit interaction fact, never inferred from a device name. Missing line or token information stays explicitly unknown. Detail previews and nested summaries are capped, with totals and truncation flags; no API returns an unbounded array. Linked subagent threads retain their own turn indexes and are included as bounded nested summaries.

`items.window` targets exactly one of `aroundSeq` or `turnOrdinal` and returns a contiguous creation-sequence window, at most 200 items and the existing wire byte budget. It includes exclusive cursors in both directions. `aroundSeq` resolves to the nearest item at or after that sequence, falling back to the last item. A turn target resolves to its initiating item or first item. Fetching a window does not replace the live subscription. The client may hold one bounded jumped window and one live tail; a new jump replaces the old jump. Advance the jumped window using its forward cursor until it overlaps the tail, then deduplicate by item id and discard the jumped window. Closing a jump discards it immediately. Paging never fills an unbounded gap in memory.

`thread.search` extends the existing SQLite FTS5 owner. Index full text in bounded chunks, including streamed text and shell output outside event payloads. Return sequence, turn ordinal, item id, source thread and plain snippets with highlight offsets. Use keyset cursors and bounded pages; cursors bind the query and scope. Filters cover messages, tool output, commands, files and errors. Scope is the thread alone or its linked subagent tree. Never parse blob chunks into one history-sized string. Report index coverage so the client can show pending indexing.

`thread.catchUp` accepts exactly one of `sinceSeq` or `sinceTime`. Its summary reads persisted digest data, never materializes transcript history. It includes settled root turns, exact current whole-tree status, changed files, commands/failures, pending/answered approvals, subagents and errors, plus the latest agent-message preview. Digests include authorized linked descendants; each thread selects literal timestamps for a time cutoff. Range details are bounded and advertise truncation. Natural-language summarization is optional: the UI explicitly sends an ordinary `thread.send` message through `ClientApi.command` when the user requests it. Reading catch-up never calls a provider.

`thread.readState` reads the authenticated device's cursor. Durable `thread.markRead` commands monotonically advance `lastSeenSeq`, capped by the host head. They never accept another device's id. The client coalesces pending updates per thread; the daemon ignores redundant writes. Read state survives reload and daemon restart and remains independent across devices.

Expose typed methods through `ClientApi`, in-process clients, shared-worker forwarding and fake mode. A streaming deterministic fixture generator supplies multi-day threads with about one million items, thousands of approvals and dozens of subagents without retaining a million-object array. A standalone benchmark measures turn pages, search and catch-up and records memory. The original implementation round permitted measurement; the current review-round rule permits only static checks. Repository tests remain merge-only.

## Review-round refinements

Deleting an indexed message recomputes its turn's initiating and latest previews from surviving messages in the canonical transaction. An upgrade repairs caches written by earlier index versions. Deleted text must not survive in navigation summaries after restart.

Each search page examines at most 128 scoped anchor postings before intersecting other terms and deduplicating items. Sparse or empty pages may carry a continuation cursor; clients continue until the cursor is null. This bounds transcript candidates per request. Checks for remaining terms still depend on one item's chunks, so adversarial latency requires measurement.

Canonical timestamps may decrease as late provider or subagent facts arrive. `sinceTime` selects literal event timestamps strictly greater than the cutoff; it never approximates time with one sequence. Counter and file deltas update seven persisted radix-256 levels covering safe integer timestamps. A suffix read visits bounded buckets independent of history. Command nodes retain the greatest canonical sequence in each timestamp bucket, so revisions follow canonical order among eligible facts. Sequence catch-up keeps the existing indexed prefixes.

Separate sequence and time completion memberships remove a reopened turn at its original settlement position, preventing an old reopening from cancelling a different completed turn after the cutoff. Completed-turn counts include settled failed and interrupted outcomes. Pending approvals and whole-tree status describe current state, including requests opened before the cutoff.

Previous databases migrate in durable 128-row batches and report `ready: false` until migration completes. A frozen indexed sequence separates old backfill from new transactional writes. Temporary durable per-item file memberships reconstruct reference deltas, including zero-line edits, and are cleaned in bounded batches. Fake mode maintains balanced range aggregates and current item/agent summaries incrementally, using the same usage-scope and settlement rules as the daemon.

Historical benchmark measurements remain labelled with their revision. The owner's review-round rule permits only static checks; updated benchmark measurements and all behavioral tests need run at merge.

## Constraints

Do not change engine actor, outbox, status-store, backpressure or snapshot internals while PR #88 owns those paths. Storage migrations and backfills must be bounded, resumable and idempotent. Derived data is written in the canonical transaction, so rollback cannot advance an index. Tombstoned threads and unauthorized descendant scopes are not readable through these APIs.
