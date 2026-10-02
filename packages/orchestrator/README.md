# @ace/orchestrator

Pure orchestration decisions and engine-facing execution ports. No provider
sessions, credentials, timers or daemon database are created here. Requires
Node 24+; provider execution is the engine's responsibility.

```ts
import { create, apply, execute, recover, spawnAgent } from "@ace/orchestrator";

// Host-owned clock and globally unique, durable ID source.
const ctx = { now: clock.now(), ids };
const run = create(input, ctx);
// Commit run.state, run.events and run.intents in one transaction.
// After commit, execute each persisted intent with backpressure.
for (const intent of run.intents) {
  const facts = await execute(run.state, intent, executor);
  for (const fact of facts) {
    const result = apply(run.state, fact, { now: clock.now(), ids });
    // Atomically persist state + events + new intents before further execution.
  }
}
```

`rerun(settledState, ctx)` starts a new run of the same orchestration definition
with fresh lanes and budgets, leaving the old run unchanged. The host pages
run summaries rather than keeping history in active state. Events carry both
orchestration and run IDs.

The snippet shows the ports, not a full actor loop. The engine must serialize
facts and persistence, drain newly committed intents, monitor thread status,
and schedule a `tick` at the run deadline. `apply` mutates the exclusively
owned state and returns only changes, like `@ace/core`. It never reads history.
Use `recover` to validate a persisted snapshot and replay its original pending
intents. Never create a second thread on recovery. Executors deduplicate
`intentId` durably, including results whose acknowledgment was lost. If an
operation throws or returns invalid data, `execute` leaves its intent pending;
the engine reconciles ambiguous I/O before deciding to retry. A definitive
start failure means no owned process remains. A cancellation resolves the
lane/attempt even when start has not yet bound a thread, fences outstanding
starts for that attempt, and returns only when
the whole thread tree has stopped. Cancelling revokes pending start/check
intents, so restart cannot launch new work for a cancelled lane. Cancellation
failures do not settle a lane.

The executor gets the pinned base SHA, workspace ID, target branch, lane
provider/model, prompt and attempt. `start` creates a worktree/thread and sends
the prompt and structured input artifact. `check` runs the configured argv and
optional review, returning only after its check processes and review agents
have stopped. `merge` applies a checkpoint. The host resolves workspace IDs
and artifact references; requests cannot pick arbitrary paths. Host adapters
must cancel/reconcile obsolete in-flight operations when an intent is revoked,
and pause all target writers before checking and applying a winner.

Templates:

- `fanout` starts all lanes with the same prompt. A partial failure preserves
  the successful results; all failed lanes fail the run.
- `race` selects the first lane passing command and optional review checks.
  It waits for the losers' stop acknowledgments before success.
- `pipeline` starts implement, then review, then fix. The last checked artifact
  becomes the next stage's input and worktree base. Shorter pipelines stop at
  their last stage; extra stages repeat fixing. Retries keep the stage input.
  Artifacts are pinned when a stage starts; already-started downstream stages
  are not automatically rerun if upstream work subsequently resumes.
- `coordinator` starts one planner. The engine's MCP `ace_spawn_agent` tool
  calls `spawnAgent(state, authenticatedCaller, args, ctx)`. It returns the
  spawned lane ID and the reducer changes. Repeating a request returns the
  same lane ID, including after restart. Every planner waits for its children;
  a failed descendant fails its parent. An agent cannot exceed the lane/depth
  limits or provide a parent ID in tool arguments.

Facts carry lane ID and attempt. Usage counters are cumulative per attempt,
not deltas. Replays/decreases cannot charge twice. Attempts accumulate usage,
and counters saturate at `Number.MAX_SAFE_INTEGER`; budgets cannot exceed
that value. Unknown monetary usage should be reported as zero and presented
as unavailable by the host, rather than estimated subscription cost. Summary
and test output are bounded metadata and host-owned blob references. There
are at most 64 lanes, depth 8 and 10 attempts; no history or streamed output is
held in this state. Runtime IDs and millisecond timestamps come from the host.

`commandHandler(port)` composes with the daemon's existing synchronous
`CommandHandler`. The injected port creates/reduces state and commits intents
inside the daemon receipt transaction; `ok` means accepted. It recognizes the
additive `orchestration.create`, `orchestration.cancel`, `orchestration.pick`
wire commands and returns `not_implemented` for other commands. Host receipt
IDs deduplicate retries. Host storage, authorization, subscription snapshots
and MCP registration are deliberately left to the engine/daemon integration.
Orchestration event and state schemas are separate from thread events.

`compare(state, git)` reads checkpoint diffs using `@ace/git` and returns
per-lane stats, test results, duration, usage and bounded patches.
`sideBySide(comparisons)` aligns file changes in a sparse table with one cell
per changed lane; absent cells mean unchanged. Both cap visible files at 4096,
and patches at 64 KiB, with explicit truncation flags.

`mergeWinner(state, targetWorktree, git)` requires a checked winner, no live
lanes, a clean target on the requested branch and the exact pinned base SHA.
It returns a safety checkpoint and applies the winner's files using
`@ace/git.restoreCheckpoint`. HEAD and the index stay unchanged. This is a
reviewable working-tree application, not a merge commit or three-way merge.
A changed target fails instead of overwriting unrelated work. The executor
must retain an application receipt so restart does not reapply to a now-dirty
target. See [ADR 0013](../../docs/adr/0013-orchestration.md).

Run `bun run test packages/orchestrator/src`, `bun run check`, and
`bun run --filter @ace/orchestrator benchmark`. Benchmarks are non-gating and
never run provider CLIs. Mutation evidence is in `VERIFICATION.md`.
