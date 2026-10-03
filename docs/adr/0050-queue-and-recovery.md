# 0050: Durable queues, continuation and usage-limit recovery

Date: 2026-10-02. Status: proposed, implemented for review.

The engine remains the single owner of provider delivery. Extend its SQLite
intents rather than introduce another queue or let adapters retain follow-ups.
The [Orchestrator V2 release notes](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)
are a behaviour reference only. No competitor source was read.

## Queue ownership

A queued message is an unclaimed send intent with a stable command ID, input,
attachment/context references and a position. Each thread has a monotonically
increasing queue revision. Edit, remove, move and resume commands compare the
observed revision in the same transaction as their receipt and changes. A stale
device gets `queue_conflict` and rereads. Claimed sends are immutable. Reordering
names one message and its predecessor, avoiding full-list uploads. Queues cap at
256 messages and each message at 256 KiB; attachments remain references.

Follow-up behaviour defaults to queue and resolves before intent admission.
An explicit send delivery overrides the setting. Clients can implement the
opposite-default shortcut without duplicating the server queue. Steers bypass
settled-turn gating only when the adapter advertises steer, the session is live,
and no recovery/limit hold exists. Unsupported steering enters the ordered queue.

The commit before provider I/O is the claim boundary. Exactly-once external
delivery cannot be promised across a crash. Unacknowledged claimed messages
become uncertain and stay visible; they are never replayed automatically.
Unclaimed messages keep their order and wait for explicit resume after restart
unless `threads.continueAfterRestart` is enabled.

## Continuation and limits

Capture interrupted foreground work and live background shells, monitors and
children before recording process exit. Persist a bounded recovery notice and
continuation intent. Native resume is capability-gated. The next resumed input
tells the agent which work died, with a `restart` run trigger. Recovery does not
pretend that dead background work completed successfully. Graceful shutdown
records this evidence before closing providers too, so updates and reboots use
the same path. Auto-continuation never replays uncertain user delivery.

`limited` is derived from rate-limit facts, with human interaction and live-tree
work retaining precedence under ADR 0004. It survives process exit independently
of retry timers. Usage limits hold sends without failing or removing them.
`thread.limit` offers resume now, resume at reset, snooze until reset and migrate
now. A persisted deadline uses the accounts quota windows' latest active reset;
resetless blockers refuse timed resume. One injected-clock scheduler seeks the
next indexed deadline and drains bounded batches. Snooze expires into a manual
hold rather than sending work. The default limit policy is configurable.

Migration first holds delivery and closes the source provider tree, then calls
the accounts service's existing migration API. Publish the destination instance
and native ID only on a migrated result, then resume. Unsupported or refused
migration leaves the queue held and reports a notice. ADR 0018's independent
writer lease remains mandatory; this feature never bypasses a refusal.

## Context meter and integration

Context occupancy is the latest provider context sample, never lifetime billing
totals. Add explicit context token, epoch and compaction facts. A session change
or compaction invalidates the old sample until a fresh one arrives. Prefer the
reported context window, then the exact account/model catalog entry; missing
data stays unknown. Persist one row per agent and expose bounded thread pages.
Provider stream deltas bypass queue, recovery and context work. Changed usage
updates only the affected agent, without reading transcript history.

Add schema-only queue/recovery definitions and exports, authenticated service
registry routes and client helpers. No edits to `server.ts`. Settings retain
their existing layered file owner. Behaviour tests use temporary SQLite and
scripted adapter boundaries, with injected clocks and explicit barriers.
Non-gating benchmark definitions report throughput and peak RSS. Under the
owner's current rule, tests, mutations and benchmarks are written but not run;
runtime evidence and numbers need run at merge.
