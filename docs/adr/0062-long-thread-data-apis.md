# 0062: Long-thread data APIs

Date: 2026-10-03. Status: accepted.

## Decision

Persist a turn index alongside canonical event writes. Reuse the stable root run ordinals from ADR 0057. User messages received before a run belong to that next turn; automatic runs also receive an ordinal. (Amended 2026-10-18: a turn is an ask and every root run after it until the next ask; automatic runs join the current turn. See "Turns are asks".) Keep item-to-turn and agent-to-turn ownership durable so late background results update their original turn. A root run ending is an outcome fact, not proof that its tree has finished. Turns remain active while their agents, tools, interactions or background tasks are live. Current thread status and its reason always come from the whole-tree status owner in ADR 0004.

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

## Web client (2026-10-04)

The thread screen keeps its leased live tail and at most one jumped window. A window slides by 100 items only as the reader scrolls toward one of its edges; scroll events caused by code (restoring the reader's place, a jump, rows changing) never slide it, so a window that fits on screen cannot page itself back and forth. A window that overlaps the tail joins it: the transcript shows the window followed by the tail's newer items, deduplicated by id, while the two overlap, and drops the window once the reader follows the live end. If the tail moves past the window's end, the window shows its gap again. The gap names how many turns lie between the window and live and offers Jump to live, which discards the window at once.

A window's items may outlive the client's runs, so their turns come from the turn index (the latest turn that started at or before each item's sequence). Turn pages are read in fixed blocks of 50 ordinals and dropped soon after nothing shows them; the newest turn the live tail shows keys the index's head read, so the client never polls it. Every turn shows whole, live and in a window; the transcript never folds turns into digest rows (owner decision, 2026-10-14). The turn rail and ⌥⌘↑/↓ move between turns, and the turns panel lists each turn with its digest.

The read cursor advances only while the reader follows the live end of a visible page. Opening a thread reads the cursor once; if the thread moved on, the catch-up digest from that cursor is shown. Summarise sends one ordinary `thread.send`. The million-item performance run serves `multiDayThread` on demand (`LongThreadSoak`: each turn owns a fixed block of creation sequences and is regenerated when a request needs it) and its budgets are in ADR 0056.

## PR 856 review: scrolling from the live tail

Loading earlier messages now opens the existing bounded history window beside the live
subscription, just as jumping does. Pages do not enlarge the live store. Older slides
recompute whether the window still meets the tail; once separated, the gap is visible again.
Proximity prefetch reads the virtualizer's visible range, excluding a retained offscreen
jump target, and consumes one upward scroll intent per read. A reply, a failed read or a
short window cannot page itself repeatedly. Newer slides mirror it: one request per
downward scroll intent near the live end. The scroll handler only observes; scroll
events with no gesture behind them (a jump landing, a keep-place restore) never page,
so a settling page cannot chain into the next one.

## Transcript order and the live tail (2026-10-17)

Every transcript orders items by the daemon's creation sequence (the seq of an item's first
upsert) and by nothing else. A snapshot's `itemOrder` is kept as the daemon sends it, a live
`item.created` is appended (events arrive in sequence order), and pages and windows merge by
sequence. `createdAt` is display-only: imported history keeps native timestamps and clocks
step, so it may disagree with sequence. Renderers never re-sort.

Paging never evicts the live tail. `ThreadStore.page` admits an older page only into the
window's free capacity, newest page items first, and ignores a page read for a cursor the
window has since left. A full window reads deeper history through the bounded `items.window`
beside it, as the thread feed does; the subagent transcript does the same.

The bounded window keeps the root agent's share: when it trims, the root's own items keep at
least half of it (`retainedTail` in `@ace/projection`), so busy subagents cannot push the
person's prompts and the root's replies out of the root transcript. Root items and other
agents' items each stay one contiguous newest run. `itemsBefore` is the cursor from which
every item is held; root items the window kept before it are deduplicated by id when history
pages or a window overlaps them, and only a window reaching past the cursor joins the tail.
The daemon's thread snapshot selects its 200 items with the same rule, so a reload or a
resnapshot holds exactly what a following client's window held. `item_heads` carries each
item's `agent_id` (schema bump; older databases are refused, as ace is pre-release) with an
index on `(thread_id, agent_id, created_seq)`: only the newest 201 heads and the root's newest
100 can be chosen, so two indexed reads serve any thread length. When those items exceed the
snapshot's byte budget, the same rule picks the largest smaller window that fits. The fake
daemon's snapshot uses the rule too.

## Transcript order and held ranges (2026-10-18)

Owner report: in a long Claude thread with two busy subagents, scrolling up made older agent
messages disappear and the person's messages showed out of order. Causes: the live tail keeps
the root lane's newest items further back than its single cursor `itemsBefore`, but loading
older read a window around that cursor (newer than the rows on screen) and dropped the root
rows older than the window; a joined window took "the tail's items after the last shared id"
instead of merging by sequence; the bounded tail trimmed rows the reader was reading; a gap
resubscribed without a cursor and the snapshot replaced loaded history. Decisions:

- **One order key.** The daemon's creation sequence travels with every item: snapshots
  (`itemSeqs` must cover `itemOrder`), `items.page` and `items.window` replies are refused
  without it, `ThreadReader.itemSeq` exposes it, and the worker's mirror carries it in item
  patches. Every merge is `mergeBySeq` (dedupe by id, order by sequence, linear); an id without
  a sequence throws instead of landing at an edge. A repeated `item.created` never moves an
  item. Ordering stays creation order (owner decision; no turn-blocked ordinals).
- **Lanes, not a global cursor.** The root share stays (owner UX: busy subagents must not push
  the person's prompts out of the root transcript), but its contiguity is per lane: the root
  lane is the root agent's items plus the thread's own agentless items (`inRootLane`), the
  other lane every other agent's. Each lane is complete from `laneBefore` (its oldest held
  item, or `itemsBefore` if older). A transcript reasons about its own lane; the daemon
  snapshot reads agentless items with a third indexed query rather than an `IN` that sorts.
- **Held range.** When the reader leaves the live end, the thread view holds the rows the tail
  shows as its history window (`holdTail`), so the shared tail's trimming never removes them.
  While the window meets the tail (its last item at or after the tail's lane cursor minus one)
  the transcript is the window and the tail's items from the window's first sequence on,
  merged by sequence. Before the tail can trim past the window's end (50 lane items of margin)
  the window takes the tail's newer lane items (`absorbTail`); at its bound it leaves the tail
  behind a gap. Reading older fetches whole turns before the window's older cursor and trims
  only the newer end; reading newer trims the older end at a turn start. A jump replaces the
  window (a second disjoint range) and joins the tail once it reaches it. Control state (runs,
  agents, interactions, tasks, thread status) is always read from the live store.
- **Whole turns.** `items.window` takes `wholeTurns`: the older side starts where a turn
  starts (`long_turns.start_seq`, new index `long_turns_start`), unless the first item already
  starts its turn; a single turn larger than the window is cut by the budgets and the cursor
  still says more is older. The fake daemon and the long-thread soak do the same.
- **Resume, don't replace.** A delivery gap resubscribes with `afterSeq` = the held cursor;
  only a second gap at the same cursor starts over without one. When the daemon answers with a
  snapshot, the store keeps each lane's held items older than the snapshot when the snapshot's
  lane starts at or before the held cursor + 1, and only the finished items after the newest
  unfinished one (events the gap skipped may have changed a running item). Otherwise the
  snapshot replaces the store; the view's held window keeps its copies and shows a gap.

- **Cached views carry sequences.** A thread view read back from disk (ADR 0030, read snapshots)
  holds each item's creation sequence and `itemsBefore`; a record without them is discarded. It
  is a held transcript, so the daemon's snapshot resumes it under the rule above. PR #898's
  separate 200-item reader window (retained before the live tail evicts it) is not adopted:
  `holdTail`, `absorbTail` and the 2,000-item history window cover it.

Older paragraphs of this ADR that describe a 200-item window sliding by 100, or a joined window
"followed by the tail's newer items", are superseded by this section; ADR 0056 records the new
window bound.

## Turns are asks (2026-10-18)

Owner decision. A turn is one ask and every root run that follows it until the next ask. A run
the agent starts by itself (a background task or subagent finished) no longer opens a turn: the
rail, ⌥⌘↑/↓, the turns panel, previews, `turns.page`, `turn.steps`, catch-up and whole-turn
windows all treat the ask and its answers as one turn.

- **Run turn.** `Run.ordinal` stays the run's own number (runs list, checkpoints). Root runs
  also carry `Run.turn`, allocated once by the daemon when the run starts, dense from 1. Runs
  recorded before this change omit it and read as `turn ?? ordinal`; a thread's turns continue
  after its last run ordinal, so nothing is rewritten.
- **What asks.** A root user-role message asks unless its origin carries the turn on:
  `subagent_result` (ace's delegation results and native subagent results),
  `background_completion`, `interaction_answer`, `restart` (ace's "Continue"), `limit_resume`
  and `handoff`. The person's own words (typed, queued, steered), `automation` and `schedule`
  prompts, a parent agent's ask in a child thread (`spawn`, `parent_agent`) and a provider-native
  user message with no origin ask (`startsTurn` in `@ace/projection`).
- **Which runs open a turn.** A root run opens the next turn when an ask is waiting that no
  started run took, or when its trigger says it was asked for (`user`, `queue`, `spawn`,
  `parent_agent`, `goal`, `schedule`: covers a person typing in the provider's own CLI, which
  ace sees only as a run). Otherwise (`background_completion`, `subagent_result`, `restart`,
  `limit_resume`, `unknown`) it joins the current turn. Claude reports `unknown` at the start of
  every run, so for Claude the ask decides.
- **Steers.** A message steered into a running run belongs to that run's turn and asks for no
  next turn. A message first indexed ahead of a run and later bound to the running one moves to
  that run's turn; the empty turn it opened is dropped (likewise for a withdrawn queued message),
  since no run started it.
- **Liveness.** A later run reopens its turn (`root_outcome` active, settlement removed) and
  updates its latest preview, end sequence, outcome and digests; a turn never reads settled
  while any of its runs is live. Usage for a turn belongs to its live (else newest) root run.
- **Clients.** `itemTurnOrdinals` numbers items with `Run.turn ?? Run.ordinal`; a carrying-on
  user-role message stays in the turn before it. The transcript keeps one "Worked for" log for
  runs that share a turn, as it already did for `background_completion`/`subagent_result` runs.
  The fake daemon allocates turns by the same rule.
- **Known gap.** When a provider emits a person's message only after the run it started and with
  a trigger that does not say so (`unknown`), the run joins the current turn. ace's own sends
  always index the message before the run, so this only affects provider-native input.

## Whole-turn reads always move (2026-10-18)

Owner report: in a long Claude thread the transcript stopped at "Worked for 1m 3s" and an agent
reply with no message above it, and scrolling up loaded nothing more. Cause: a turn that no
item starts (a run the agent started itself under the old one-turn-per-run rule, or a run the
person started in the provider's own CLI) begins at its `run.started` sequence, before its first
item. An older read is aimed at that first item. When the turn before it filled the whole older
part of the read (a single turn larger than the read, which is more common now that agent-started
runs join the ask's turn), the only turn start between the read's first item and its target was
the target's own. The whole-turn cut kept only the target, and the reply's cursor was the one the
read was made from, so every later read returned the same single item.

- A whole-turn cut keeps at least one item older than the target. It cuts only at a turn start
  at or before the newest older item; with none there, the older part is one turn larger than the
  read and the budgets cut it (the existing rule). Every older read before the thread's start
  moves the cursor, whatever its turns begin with.
- No index repair is needed: `long_turns.start_seq` stays the sequence of the event that opened
  the turn, for old-rule and new-rule turns alike. The fake daemon applies the same cut; the soak
  already chose turns by membership and was not affected.
