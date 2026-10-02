# 0013: Local multi-provider orchestration

Date: 2026-10-02. Status: accepted.

## Context

The supplied competitor inventories describe t3code's multi-model worktrees,
Claude's parallel sessions and agent teams, Codex worktrees, Cursor Projects
with coordinators, and Antigravity's command center. Parallel agents already
exist. The missing contract is a portable run that compares providers, passes
structured results between stages, chooses a checked winner, and survives a
restart without losing ownership of children. These inventories inform the
feature scope only. No competitor implementation is used.

ace already derives thread status from the entire agent tree. Orchestration
must consume that status rather than treating a provider's turn-end as success.
A coordinator finishing cannot hide a child waiting for human input.

## Decision

Add `@ace/orchestrator`. Its core accepts facts and injected time and IDs and
returns events and durable execution intents. It performs no I/O. The engine
will implement an executor that creates isolated worktrees and threads, sends
prompts with artifact references, runs checks, interrupts whole thread trees,
and applies checkpoints. Engine integration and provider execution remain in
the engine workstream. No provider CLI is invoked by this package's tests.

An orchestration definition has independently persisted runs and paged run
summaries. Rerunning a settled definition gives it a fresh run, lanes and
budgets, preserving prior results. Events carry both orchestration and run IDs.
A template defines each run: fanout starts every lane with the same prompt;
race starts every lane and selects the first checked success; pipeline starts
one stage at a time with explicit implement/review/fix instructions, passing the previous stage's structured artifact; and
coordinator starts one planner which can request nested lanes through the
`ace_spawn_agent` entry point. A persisted orchestration contains its run ID,
lanes, counters, usage, winner, and pending intents. Each attempt has a fresh
thread and worktree. Late facts carry the attempt number and are ignored.

Lane completion needs an aggregate thread `done`, an artifact, successful
command checks, and successful optional agent review. A parent also waits for
its descendants. Cancellation is an intent, not proof of termination. A run
stays cancelling until every started lane acknowledges that its entire thread
has stopped. Failures retry within a template limit; usage accumulates across
attempts. Budgets cover elapsed time, tokens, reported monetary cost, total
lanes, retries, and coordinator depth. Missing provider cost remains unknown;
monetary limits apply to reported usage, not estimated subscription charges.

Persist the state and its events atomically before executing intents. Executors
must deduplicate by intent ID, including starts, checks, cancellations and
merges. On restart replay pending intents with their original IDs and reconcile
existing thread statuses. Never start an extra thread merely because a receipt
was lost. This package provides the replay contract; SQLite ownership belongs
to the engine. Its execution helper acknowledges successful effects only. Recovery
uses the same executable-phase rules as the executor and rejects stopped-start
intents, ambiguous generations, bad ownership and missing required effects.

## Protocol and wire additions

New schema files define templates, runs, lanes, artifacts, budgets, comparison
results, snapshots, facts, effects, and orchestration events. Artifact payloads
contain checkpoint and blob references, a bounded summary, and structured test
results. Diffs and logs stay outside orchestration snapshots.

Add `orchestration.create`, `orchestration.cancel`, and `orchestration.pick` to
the existing command union, so existing authenticated WebSocket command and
receipt handling applies unchanged. An injected command port commits intents
inside the daemon receipt transaction. Orchestration event and snapshot schemas
are exported separately for later subscription wiring; they do not change the
thread event log or claim to implement client subscriptions here.

`ace_spawn_agent` is an engine/MCP entry point scoped to the requesting lane.
It accepts a lane spec and request ID, uses the same reducer, deduplicates
requests, and cannot exceed the run's depth or lane budget. It does not grant
permission to pick winners or change checks.

## Comparison and applying a winner

`@ace/git` owns checkpoints and diff stats. Compare each successful lane's
checkpoint against the pinned base, returning per-file additions/deletions,
binary markers, a bounded patch summary, check results, duration and cumulative
usage. Large patches are truncated for display only, never applied as patches.

Picking requires a checked successful lane and every other lane to settle.
Race automatically picks its winner but waits for cancellation acknowledgements
before declaring success. Cancellation revokes pending starts/checks; the
executor fences outstanding starts for that lane and attempt before confirming
the stop. Applying a winner is a separate durable intent.
The target must be clean, on the requested branch, and at the pinned base SHA.
Use `@ace/git.restoreCheckpoint`, which creates a safety checkpoint and applies
the winner's files without moving HEAD or the user's index. This git API has no
commit/three-way merge operation. The applied files are therefore reviewable
changes on the target branch, not an automatic merge commit. A changed target
fails rather than overwriting unrelated work. A receipt includes the safety
checkpoint so an interrupted apply can be reconciled by the engine. External
writers must be paused during application, as the git service cannot lock them.

## Security

All entry points parse Zod schemas. IDs, prompts, artifact metadata, checks and
lane counts have explicit limits. Commands use argv, not shell interpolation;
checks execute only inside engine-created lane worktrees. The authenticated
host resolves workspace IDs and target paths; remote requests cannot nominate
arbitrary filesystem roots. MCP callers are bound to their parent lane by the
engine's session credential, never by an untrusted parent ID alone. Artifact
references are host-owned. Agent-produced summaries are data, not commands.
No provider credentials are accepted or stored. Provider work uses only local,
user-installed CLIs through engine adapters, following ADR 0002.

## Performance

Runs are capped at 64 lanes and depth 8, with at most 10 attempts per lane.
Counters update per changed lane, and parent propagation is bounded by depth.
Common thread/usage facts do not scan prior events or copy snapshots. Checks
and artifacts are bounded. Pending intents are removed on acknowledgement;
spawn receipts are bounded by the total lane cap. Cancellation and recovery
scan at most the capped current lanes/intents. Persisted state contains no
history and no full diff. Executors process intents with backpressure, leaving
streaming outputs to the engine's output store. A non-gating benchmark measures
thread/usage fact throughput and peak RSS at maximum lane count.

## Testing

Exercise the public reducer with injected time and IDs: partial fanout failure,
race check rejection and loser cancellation, pipeline artifact transfer,
nested coordinators with depth rejection, waiting descendants, stale attempts,
retries, budget exhaustion, restart intent replay and command routing. Use
real temporary Git repositories for comparison and winner application,
including dirty and advanced targets. Run the repository check and prove at
least eight production mutations are caught by behavioural tests before PR.
