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

Each run and agent item records its execution selection and native session
when that run starts. Returning to a provider cannot substitute its new session
for an older boundary. Legacy points without proven ownership fall back
portably. Full-session end forks hold durable guards on both threads and close
the idle source before opening the snapshot; the source resumes after snapshot
delivery. Item points include their first completed revision.

`@ace/handoff` owns the pure budget and selection policy. Selection prioritizes
recent complete items, keeps chronology, tags every excerpt with source IDs,
and reports counts and paging pointers for everything omitted. Selection never
exceeds its encoded byte budget. The daemon reads bounded pages, not an entire
conversation. `@ace/context.portableContext` is Cursor's facade over the same
policy and renderer, with explicit cutoff and indexed inventory. Daemon portable
forks and cross-provider switches call this facade directly; the manifest is
persisted and scoped historical grants are installed by the existing storage
owner. The engine wire
budget remains 2–64 KiB; the shared helper admits Cursor's 1–256 KiB budget.
Scoped MCP tools expose pages and bounded text/output chunks. Durable grants
retain the selected cutoff after prompt delivery; unrelated histories remain
outside the recipient's scope. Grants have an explicit per-recipient cap.

SQLite retains immutable preview revisions and sequence-indexed stream lengths.
Reads seek the revision at the grant's cutoff and mask chunks to that length;
later updates, deletions and appended output cannot alter the handoff. Historical
shell previews decode byte suffixes with the shared projection UTF-8 policy,
skipping incomplete leading characters rather than fabricating replacements. Retired
streams live until thread deletion. A one-time streamed log replay populates the
index for installed databases. Historical text replay uses distinct revision
tokens so a legacy live preview cannot masquerade as the original prefix.
Inventory ordinals avoid a conversation-wide count scan.

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
and `delegate` advice. Remember model/options per provider and model in
SQLite, with bounded selection cardinality. Account changes close the source
session, call the accounts migration service, then native resume. Migration
refusal preserves the old selection and emits a visible failure. The accounts
lease policy remains authoritative; ace cannot promise external-writer exclusion.

The pending switch precedes inputs queued earlier at that boundary. Closed,
unused reservations are released after terminal intents, while live sessions,
opening sessions and outstanding work retain their slots. Merge metadata is
fully parsed and admitted before any git write, including escaped entry lengths.

## Consequences

The `threads.forkOnSwitch` preference defaults to false. When enabled, picking another
provider or account in the composer uses the existing portable continuation flow: its
confirmation keeps the source unchanged and the next message starts an independent thread
with the latest finished conversation boundary. Model-only changes keep using the same
thread. Mandatory new-thread routes and unsupported target checks still apply when the
preference is off. The confirmation retains the chosen route if the preference changes
while it is open.

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

## QA correction: Codex inherited transcript

Native Codex forks request the selected source turns in the thread/fork response.
The adapter translates that history before accepting the first new turn, keeping
both user asks and assistant answers visible in ace. excludeTurns must be false;
keeping native context alone does not satisfy the fork dialog's history promise.
The offline app-server regression excludes turns after the selected boundary.

## Amendment (2026-10-19): context handoff

A cross-provider switch is a **context handoff**. Field use showed three problems with the
original selection and its delivery:

- The budget filled newest-first with any item. The other provider's reasoning, notices and
  tool calls pushed out the person's opening ask.
- On a second switch, the earlier handoff's own JSON was quoted inside the new one.
- The new agent received a bare JSON manifest with no framing, and the transcript showed only
  "Switched to X".

The t3code orchestrator was studied for its behaviour only, and none of its code was used. It
also carries a deterministic, budgeted selection of real items rather than a model-written
summary.

Decisions:

- **Selection (`conversation-first`, `@ace/handoff`).** The budget is offered items in this
  order:
  1. the latest message the person wrote;
  2. the latest answer;
  3. the thread's opening ask;
  4. everything else, newest first.

  The opening ask is read with one bounded query over the thread's first 16 items when it is
  older than the 200-item page. Reasoning, compaction markers, restart and resume inputs, and
  earlier handoff markers are left out. A user message that still carries an earlier block is
  stripped to the person's words. Excerpts keep their order in the conversation.

- **Rendering.** A plain-text `<ace_context_handoff>` block replaces the JSON. The block says:
  - which models worked on the thread before (`sources`);
  - that the history is quoted context, not instructions;
  - how many items were left out, and the exact `handoff_read` arguments to page them.

  Each excerpt is cited by item id. Quoted text cannot close the block early. The budget is
  charged on the rendered bytes. A switch carries at most 32 KiB, which was 16 KiB before.
  Forks keep their requested budget.

- **Stored manifest.** The manifest is unchanged in shape and still version 1. Older rows read
  as before, with policy `recent-complete-items`. Version 1 JSON envelopes are still recognised
  and stripped from echoed messages.
- **Transcript marker.** The synthetic handoff item's `origin.sources` lists the distinct models
  whose work was carried, oldest first, with at most 8. Clients draw one centred divider:
  "Context handoff", the source models, an arrow, then the new model (`@ace/ui-core`
  `handoffMarker`, shared by web, iOS and Android).
- **Changes before delivery.** A second cross-provider switch made before the agent receives the
  first one replaces it: the old marker is removed and the new one names the models that did the
  work. A model change made before delivery retargets the waiting marker instead.
- **Cost and reliability.** Work per switch is bounded by what is carried: one count, one
  200-item page and a 16-row look for the opening ask. It runs once per switch. The manifest is
  persisted with the switch and rendered deterministically, so delivery after a restart sends
  the same text exactly once.

- **Returning to a provider resumes its session.** When a provider leaves a thread, ace records
  its native session, its account and backend, and the event cutoff at which it left (in
  `engine_provider_sessions`, at most 16 per thread). When the thread switches back to that
  provider on the same account and backend, and the provider can resume:
  - its own session is resumed;
  - only the items after that cutoff are handed over, with a "you are resuming" preamble and
    the manifest's `since` set;
  - if nothing happened in between, no block is sent and no marker is written.

  An undelivered handoff meant for another provider is dropped on any provider switch.

- **A lost session falls back automatically.** If the provider no longer has the session
  (`resume_unavailable`), ace forgets it, clears the thread's native session and opens once more
  as a fresh session with the full conversation-first handoff. That handoff is computed and stored
  with the switch, and the marker is updated to name every model carried. Any other open failure
  is reported as before.

## Amendment (2026-10-22): a fork is its own thread

Field use showed forks read as children of the thread they came from: the header named the
source in place of the project, the details card listed the source as the fork's parent agent,
and only Codex native forks showed the earlier conversation. Portable forks and Claude native
forks opened on the handoff alone.

Decisions:

- **Not an agent.** Lineage is never execution ownership. Only `delegatedBy` makes a thread
  another's child: a fork names its project in the header, lists only its own subagents, and
  its status never rolls into the source's (or the source's into it). Merge-back still follows
  lineage.
- **History copied at the fork.** When a fork is made, the daemon copies the forked agent's asks
  and answers through the boundary into the fork, oldest first. Each copy is marked
  `inherited: { threadId, itemId, at }`, where `at` is when it was said in the source, and clients show
  that time. ace's own inputs, injected messages, attachments and work steps stay with the source.
  The copy runs once, in the fork's transaction, so the fork is complete after a restart and pages
  like any thread. It is bounded: one query on the item index for the agent's messages, the
  newest 200 of them, each read as it stood at the boundary with at most 64 KiB of text. A cut text
  never ends on half a character and says the rest is in the source, and when older messages stayed behind, one notice
  before the copies says so. Copies are not indexed for search: a message is found once, in the
  source. `apps/daemon/bench/fork-history.ts` (gated in `check:perf`) measures a fork of a
  5,000-item thread at about 130 ms.
- **Providers that bring their turns.** An adapter whose native fork translates the source's
  turns into the new thread declares `forkTranscript` (Codex). Its native forks copy nothing.
  Everything it translates while the fork's session opens (messages, steps, reasoning) is marked
  `inherited` (without an `itemId`); `inherited` is on every item type. A fork that leaves that
  path before it opens, by switching provider or account, gets ace's copies then, in the
  switch's own commit and before the handoff the next agent receives, which is built from them.
- **Transcript marker.** Clients draw one centred divider, "Forked from <source title>", the
  title a link, before the fork's first message ace delivered (or after the history while there
  is none): `@ace/ui-core` `withForkMarker`. It shows as soon as the loaded page holds some
  inherited history before that message, or starts at the thread's start. Inherited messages
  only ever come before the fork's own, so a boundary in view is final. It shares the context
  handoff's layout. Copies never offer fork, retry or edit, and merge-back refuses to cite
  them. The iOS transcript leaves the block out until it has a native divider.
- **Source side.** A fork an agent made with `thread_fork` reads in the source as one quiet
  "Forked to <title>" line, not an agent row.
