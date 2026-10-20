# 0090: Native Offshift workflow records

Date: 2026-10-16. Updated 2026-10-19. Status: accepted.

## Context

Offshift existed as machine-installed instructions with Python record and panel helpers. ace had
no native Offshift package or entry point. The former conductor feature was removed (ADRs 0017
and 0060). Agent execution, delegation ownership, durable delivery, canonical tree status and
automation already have owners. A second provider runner would duplicate them, and ADR 0086 caps
the agent-facing tool surface.

## Decision

Add `@ace/offshift` in erasable TypeScript for Node 24. Its pure transitions own bounded
acceptance criteria, phase changes, blockers, criterion revisions and revision-bound evidence. A
synchronous SQLite journal shares the daemon's transaction boundary, so state and idempotency
receipts commit together. Optimistic versions reject conflicting updates; an identical retry
returns a fresh view without repeating the mutation.

Agents reach it through one control tool, `offshift`, in the `ace-threads` family (ADR 0086). Its
`action` is one of `start`, `get`, `list`, `advance`, `block`, `resume`, `evidence` or `revise`.
The input is one flat object, with each action's required fields checked before anything runs.
It sits behind the `thread_control` capability, like the other tools that write to the caller's
own thread. The daemon routes the `offshift` agent-control operation through the agent owners
registry (`createAgentOwners`), beside handoffs and automations. Only the calling thread owns its
runs: attribution comes from the authenticated MCP lease, and no input selects a workspace,
thread, provider credential or shell command. Native CLI execution stays with the engine; child
work stays with `DelegationService`.

`revise` adds a criterion, or replaces the one with the same id. That criterion's earlier
evidence is dropped, since it checked the old requirement. The 64-criteria bound holds, and
revising is refused while the run is blocked.

A freshly written `offshift` skill ships through the built-in skill projection and the `guide`
fallback. It records; it does not repeat ace's other skills. It sends delegation to
`plan-and-delegate`, review to `review-changes`, the PR endpoint to `prepare-pr`, failures to
`fix-failing-tests` and `investigate-bug`, UI evidence to `ace-browser`, and handoff and thread
changes to `ace-threads`. Durable project facts go to project notes (`note_add`). A blocker is a
record; the person is asked through `ask`. Pause and stop use native thread controls.

The daemon captures evidence identity with the existing Git snapshot code: HEAD, tracked and
nonignored content, and checkout identity. This writes Git objects through a temporary index
but no checkpoint ref or commit. Capture happens only on explicit workflow requests, never on
streaming events. Ignored build products and external environment state remain evidence
annotations. Source changes invalidate earlier passes. When the workspace is not a Git
repository, or Git cannot snapshot it, the call answers `unavailable` with a next step for the
agent rather than failing the tool or omitting the source.

Completion is derived on every read from the delivery phase, current passing evidence for every
criterion, no blocker, and canonical whole-tree done. Native thread status owns agents,
interactions and background work; the existing monitor supplies delegated local and remote
descendants, counting remote children beyond its 64-entry display. A provider turn ending, or a
cancellation being accepted, cannot complete a run. The record survives restarts; it is not a
background scheduler and adds no route, palette entry or runner.

Run and evidence byte caps and per-thread and per-run limits bound reads and receipt growth.
Records cascade on owner-thread deletion and are purged with transcript payloads. Artifact
references stay inert data. Agent-reported evidence proves neither authenticity nor
authorization. The workflow adds no permission mode and grants no publication or deployment
authority.

## Clients

The person sees the run, not only the agent. Every successful change (start, advance, block,
resume, evidence, revise) appends an `offshift.updated` thread-log event in the same transaction
as the run write; reads, receipt replays and refused requests append nothing. The event carries a
bounded `OffshiftRunCard` of that one run as observed at the write: outcome (512 characters,
with a truncated flag), endpoint, phase, blocker, version, revision, the first 16 criteria with
each required kind's state (pass, fail, stale or missing) and the first 16 pending kinds, with
full counts. Notes, actions and artifacts stay in the record. A card stays under 24 KB at the
run limits and is usually well under 2 KB.

Thread views and snapshots keep only the most recently updated run's card, so a snapshot stays
bounded however many runs a thread starts; the daemon materializes it beside the queue and it
survives restarts. The card says what the run recorded, but the agent writes it mid-turn, so the
card alone can never mean done. The Summary tab words it against the whole tree with the fixed
status words: Waiting while a blocker is recorded; otherwise the tree's own state (Working,
Approve, Answer, Failed, Waiting) while anything in it works, waits on the person or is held;
Waiting while a settled tree leaves the run unfinished; Done only for a delivered run with every
kind current on a settled tree. A done run leaves the Summary. There is no route, palette entry,
composer strip or sidebar change.

## Verification

Behaviour coverage uses real SQLite through the public journal: reopening, concurrent versions,
request replay, failed and stale evidence, criterion revision, blockers, and live or
human-waiting trees. Daemon coverage calls `offshift` through a real MCP client, checks
authenticated thread isolation and the real Git revision boundary, and covers the non-Git
`unavailable` answer. It also proves that a change publishes the card to subscribers and
snapshots, that replays and refusals publish nothing, and that the snapshot keeps the card after
the store reopens. The web Summary is tested against the fake daemon for a blocked run, missing
evidence, and a delivered run that is not Done while a subagent still works.
