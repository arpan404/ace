# 0065: Transcript input admission and provenance

Date: 2026-10-04. Status: accepted.

The daemon creates a complete user transcript item when it accepts a send, before
opening a provider. Its stable ID is `input:<commandId>`. Clients can display a
pending send under that same ID and replace it when the daemon item arrives.
Transport loss leaves durable commands pending until a receipt or definite refusal.

Input origins distinguish the person's text from interaction answers, delegated
work, handoffs, automation, restart and limit continuation. Optional fields keep
older history readable. Echo matching belongs to the daemon, uses an indexed,
durable journal and matches the oldest sent input with the same text on the root
agent. Echoes update the admitted item, preserve original person-authored parts,
and record the provider's native boundary. They never create another user bubble.

Stop fences the run it targets and pauses queued input. Provider admission and
run completion remain distinct facts. Neither an echo nor a receipt means the
agent tree has completed.

## Review amendments

External commands always admit person-authored text and the user run trigger.
Only the in-process `Engine.internalHandler` and `Engine.spawn` paths accept
ace provenance and trusted triggers. Device IDs do not grant that authority.
An explicitly supplied title is person-authored, even when it equals the
provisional text or “New thread”. Trusted prepare commands preserve agent titles.

Claiming reserves queue work; it does not certify possible provider consumption.
The engine records the submitted generation immediately before provider I/O,
after preparation. A crash in that narrow committed interval remains uncertain.
Exits only expire submissions belonging to that generation. Proven-unsent input
returns to the queue after Stop or a restart. Acknowledged input is annotated
through its run ownership when Stop interrupts it.

Echo matching uses shared adapter serialization, delivery generation and native
aliases. Removal retires matching rows and aliases. Thread deletion cleans up the
journal. ACP streamed echoes retain the outgoing prompt's identity and original
parts. Deltas and assistant frames bypass journal lookups.

Native interaction identity and terminal state are persisted independently of
translator lifetimes. Resolved/expired native item identities cannot reopen an
interaction. Pending process-bound interactions expire with
`provider_disconnected`; stale answers receive `interaction_expired` or
`interaction_unavailable`. A genuinely ambiguous answer to a live request keeps
its first-answer reservation. Opening history reconciles completed tools without
reopening them. Automatic restart input is `continue`, with restart provenance
and no warning notice. Existing verbose continuation records are normalized when
sent. WP4 owns classification of new versus historical Codex requests.

`queue.resend` compares a revision, retires an uncertain copy, and creates its
replacement under the recovery command ID in one transaction. It releases only
an uncertainty hold with no remaining ambiguity, quota or continuation. Manual,
Stop and recovery holds remain. Removing the final ambiguous copy exposes an
explicit Resume pause. Clients must explain duplicate execution before resend.

Title regeneration seeks the oldest person input through a SQLite predicate
index and hydrates one bounded page. Worktree Git execution is injected at the
engine boundary. The merge-only `apps/daemon/bench/ux-inputs.ts` reports title and
admission/echo p50/p95 latency and RSS for 0, 1,000, 10,000 and 50,000 historical
items. No benchmark numbers are claimed in this round: the owner prohibits
execution outside the merge gate. Measurements need run at merge.
