# 0082: Native Offshift workflow records

Date: 2026-10-16. Status: accepted.

## Context

Offshift currently exists as machine-installed instructions with Python record and
panel helpers. ace has no native Offshift package or entry point. The former
conductor feature was removed, as recorded in ADRs 0017 and 0060. Agent execution,
delegation ownership, durable delivery, canonical tree status and automation already
have owners. Reintroducing a second provider runner would duplicate those owners.

## Decision

Add `@ace/offshift` in erasable TypeScript for Node 24. Its pure transitions own
bounded acceptance criteria, phase changes, blockers and revision-bound evidence.
A synchronous SQLite journal shares the daemon's transaction boundary so state and
idempotency receipts commit atomically. Optimistic versions reject conflicting
updates; identical retries return a fresh view without repeating mutations.

Expose `ace_offshift` through the existing authenticated agent-control toolkit.
Only the calling thread owns its runs. No input selects a workspace, thread,
provider credential or shell command. Native CLI execution remains with the engine;
child work remains with DelegationService. Ship a freshly written `offshift` skill
through the existing built-in skill projection and guide fallback.

The daemon captures evidence identity with the existing Git snapshot implementation,
including HEAD, tracked/nonignored content and checkout identity. This creates Git
objects using a temporary index but no checkpoint ref or commit. Capture occurs on
explicit workflow requests, never streaming events. Ignored build products and
external environment state remain evidence annotations. Unsupported snapshot states
fail rather than silently omitting source. Source changes invalidate earlier passes.

Completion is derived on every read from delivery phase, all current passing
evidence, no blocker and canonical whole-tree done. Native thread status owns agents,
interactions and background work; the existing monitor supplies delegated local and
remote descendants. A provider turn ending or cancellation being accepted cannot
complete a run. A completion request made while the owner is working remains waiting.
The record is durable across restart; it is not a background scheduler.

Run/evidence byte caps and per-thread/run limits bound reads and receipt growth.
Records cascade on owner-thread deletion and participate in transcript cleanup and byte accounting. Artifact references remain inert data.
Agent-reported evidence is not a proof of authenticity or authorization. The native
workflow adds no permission mode and grants no publication or deployment authority.

## Verification

Behavior coverage uses real SQLite through the public journal, including reopening,
concurrent versions, request replay, failed and stale evidence, blockers, and live
or human-waiting trees. Daemon coverage checks authenticated thread isolation and the
real Git revision boundary. Static checks run during development; suites run at merge
under the repository's current machine-load policy.
