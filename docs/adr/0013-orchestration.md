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
has stopped. Stop receipts carry the cancellation intent ID. A revived lane
under a stop reason gets fresh cancellation ownership, and cancelling ancestors
keep their phase. Descendant revival invalidates pending and accepted ancestor
checks. Matching start receipts bind independently of earlier status facts,
without regressing phase; conflicting bindings are rejected.
Failures retry within a template limit; usage accumulates across
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

## Amendment: agent-accessible orchestration, 2026-10-11

Extend the daemon's existing agent-control port and protocol operation union.
The authenticated MCP lease selects the caller; arguments never select a parent.
Keep `delegate_task`, `ace_spawn_agent`, `ace_list_agents`, `ace_wait`,
`ace_thread_info` and the existing thread readers compatible.

- `ace_agents_catalog` pages the composer's live model catalog by provider and
  account. Return model identities, reasoning efforts, service tiers, native
  permission modes, installation/authentication state and redacted account
  availability. Never return account homes, environment or credentials.
- `delegate_task` retains stable request IDs and async default. Optional
  `waitMs` bounds observation without cancelling accepted work. Optional
  `workspace` selects the project, an existing registered Git worktree, or a
  new daemon-owned worktree from an explicit base. Omission retains the caller's
  workspace. Reserve capacity before filesystem effects.
- `ace_agent_status`, `ace_agent_result`, `ace_agent_message` and
  `ace_agent_cancel` address an owned child by thread ID. Status distinguishes
  working, human wait, child wait, available result, failure and cancellation.
  Result reads do not consume the durable parent notification. Follow-ups use
  the same child and existing generation accounting. Cancellation cascades.
- `ace_threads_list` lists or searches the caller's project with a bounded
  cursor. `ace_thread_read` remains the paginated state/timeline reader.
  `ace_thread_start` creates an ordinary conversation with a required workspace
  strategy, selection, permission mode and initial text. It has durable caller
  ownership and request deduplication, but no child attachment or result wakeup.
  `ace_thread_message` adds restart delivery to queue and steer;
  `ace_thread_interrupt` and `ace_thread_configure` operate on owned threads.

Schemas remain in `@ace/protocol`. Pages are bounded by encoded bytes as well
as row count and use the MCP registry's JSON budget. Discovery reports retained
catalog freshness rather than launching a provider session to inspect models.
The existing daemon workspace creation owner handles Git and compensating
cleanup. No second Git-worktree lifecycle or provider launcher is introduced.

Permission ancestry is independent of conversation ancestry. Both children and
ordinary launched conversations retain their caller's native permission ceiling
across restarts, settings changes and provider/model switches. The engine checks
explicit policies using a conservative known-policy comparison; a display risk
label is not evidence of containment. Unknown policies may only retain an exact
same-provider policy. Unverifiable cross-provider/default policies are rejected
before launch. Native sandbox and approval choices are the runtime modes in ace;
there is no additional provider-independent runtime-mode flag.

Child completion continues through `DelegationService`: aggregate canonical
status must settle first, including all descendants and human waits. Persist
outcome and delivery ownership atomically, coalesce notifications, and enqueue
an ace-origin `subagent_result` input on the parent. Restart replays that durable
delivery. Bounded observers cannot lose a background wakeup. Keep remote capacity,
budget admission, depth/child limits and cancellation fences in the same owner.

Development verification for this amendment uses formatting, lint and sequential
package typechecks. Behaviour tests are written but run only by the merge gate,
under the owner's machine-load restriction.
