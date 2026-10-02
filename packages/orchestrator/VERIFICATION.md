# Orchestration verification

All tests use the public package API. Provider execution is fake. Git tests
use real temporary repositories and checkpoint restores. No provider prompts
or recorder sessions were run.

## Behaviour coverage

- Three provider lanes receive the same fanout prompt; one failure preserves two successes.
- Fanout outcomes remain correct across all 48 completion orders and success combinations.
- Races reject failed checks, pick the first passing lane, and await loser stop acknowledgments.
- Race winners remain correct across all 48 completion orders and check combinations.
- Pipelines instruct implement, review and fix, starting only after the prior stage passes.
- Pipelines pass checkpoint, summary, diff and structured test references between stages.
- Failed pipeline stages cancel queued stages without starting them.
- Pipeline retries preserve their upstream artifact.
- Human approvals and background work prevent completion and premature checks.
- Aggregate done without an artifact remains incomplete.
- Optional agent review is required even when the command passes.
- Stale checks cannot finish a thread that resumed, including after a new check starts.
- Newly active work reopens an already successful lane.
- Persisted starts, checks and cancellation intents replay with original IDs.
- Corrupt lifecycle counters and false successful snapshot statuses are rejected.
- Nested coordinators reject tasks past the depth limit and wait for human-blocked descendants.
- Failed descendants fail the idle planner.
- Planner cancellation needs both its own stop and its descendants' stops, in either order.
- Total lane caps prevent further spawns; non-coordinator templates cannot spawn.
- MCP spawn scopes parent identity to the caller and returns the same lane after restart/retry.
- Oversized artifacts cannot end a thread or create check work.
- Token, reported cost and deadline exhaustion cancel live lanes and await their stops.
- Replayed/decreasing usage does not charge twice.
- Retries accumulate usage, reject old attempts and stop at their attempt cap.
- Late binding after cancellation cannot reactivate a lane.
- Late final usage still marks an over-budget result as exhausted.
- Lost start receipts bind the original fake thread and deliver pipeline input.
- Invalid executor output and failed cancellation preserve pending intents for recovery.
- Revoked start intents never launch fake threads after cancellation.
- Existing daemon command envelopes route create, pick and cancel to the transactional host port.
- Real checkpoints yield correct per-file diff stats, patches, duration, usage and test results.
- Applying the real winner preserves HEAD/index and produces a usable safety checkpoint.
- Dirty, advanced and wrong-branch targets retain their data and refuse application.
- Picking cancels other lanes and delays application until they acknowledge stopping.
- Failed applications can be retried; pending applications can be cancelled.
- Resumed selected lanes revoke pending application and ignore its stale receipt.
- Run deadlines also revoke pending winner applications.
- Sparse side-by-side summaries align shared paths and retain lane-specific changes.
- Reruns keep the definition, assign fresh run/lanes/budgets and isolate prior results.

## Review regression coverage

`bun run check` passes with 458 tests and four existing skips. The orchestrator
has 72 passing tests. The initial review probes went red before production
changes: cancellation revival, ancestor cancellation phase, obsolete ancestor
checks, deferred start bindings, and cancelled snapshots with start intents.
Each was rerun green after its fix. Additional stop-generation and closed-run
revival probes were also run red before their fixes.

- Revived work retains cancellation ownership through persisted-state recovery.
- Revived children preserve cancelling ancestors and their executable stop effects.
- Reopening a settled child reopens all formerly successful ancestors.
- Old ancestor check X cannot approve the lane while current check Y is pending.
- Previously accepted ancestor checks are invalidated across a nested chain.
- Deferred start receipts bind after earlier status without regressing the phase.
- Matching receipts bind working, waiting, collecting, checking and terminal lanes.
- Conflicting resource bindings are rejected; identical repeats preserve ownership.
- Real Git comparison still includes lanes whose status arrived before their binding.
- Old cancellation receipts cannot settle revived work's new cancellation generation.
- Later aggregate failures invalidate success; expired closed-run revivals are cancelled.
- Recovery rejects unexecutable phases, wrong keys/attempts, duplicate generations and missing required effects.
- Side-by-side summaries expose upstream truncation and their global row cap.
- Pipeline tests guard stage roles rather than exact instruction wording.
- Command routing creates observable orchestration state through the fake transactional host port. Production daemon persistence remains the engine's responsibility.

## Mutation audit

Run `python3 packages/orchestrator/bench/mutations.py`. Each temporary production
edit must trigger a behavioural assertion failure and is restored in `finally`.
The script refuses to touch `packages/git`. All 27 were caught and reverted,
including the three review survivors at rows 19–21.

| #   | Mutation                             | Behaviour that failed                                 |
| --- | ------------------------------------ | ----------------------------------------------------- |
| 1   | Wrong fanout prompt                  | Lanes receive the user's prompt                       |
| 2   | Disable race winner                  | First passing race wins                               |
| 3   | Immediate cancellation completion    | Budget cancellation awaits stops                      |
| 4   | Drop pipeline artifact input         | Next stage receives the artifact                      |
| 5   | Allow extra depth                    | Nested tasks obey depth cap                           |
| 6   | Token `>=` to `>`                    | Exact token exhaustion cancels                        |
| 7   | Accept old attempt                   | Stale retry facts are ignored                         |
| 8   | Charge cumulative usage as a delta   | Usage replay cannot charge twice                      |
| 9   | Ignore unfinished children           | Planner waits for descendants                         |
| 10  | Skip optional review                 | Command pass still needs review                       |
| 11  | Drop recovered intents               | Original work replays after restart                   |
| 12  | Remove target branch guard           | Wrong-branch application is refused                   |
| 13  | Ignore command failure               | Race cannot select a failed check                     |
| 14  | Omit child decrement                 | Planner finishes only after children settle           |
| 15  | Ignore untracked target dirt         | Local files are preserved                             |
| 16  | Cost `>=` to `>`                     | Exact cost exhaustion cancels                         |
| 17  | Disable binding                      | Start receipt preserves thread identity               |
| 18  | Raise artifact cap                   | Oversized artifacts cannot create work                |
| 19  | Remove recovery ownership validation | Miskeyed and mismatched-attempt receipts are rejected |
| 20  | Disable ancestor reopening           | Nested revival keeps ancestors active                 |
| 21  | Suppress summary truncation flag     | Incomplete file metadata is signalled                 |
| 22  | Omit revived lane cancellation       | Revived work still needs stop acknowledgment          |
| 23  | Keep old ancestor checks             | Obsolete X cannot approve current Y                   |
| 24  | Bind only starting lanes             | Status-before-receipt retains binding                 |
| 25  | Skip recovery phase compatibility    | Cancelled snapshots cannot replay starts              |
| 26  | Keep accepted ancestor checks        | Reopened descendants force fresh ancestor checks      |
| 27  | Suppress global row overflow flag    | Capped comparison marks dropped rows                  |

## Non-gating benchmark

`bun run --filter @ace/orchestrator benchmark`, Node 26.8.1. Each fact path runs
300,000 operations per lane count, including public schema parsing. Thread
facts change each lane's phase every round, including counter/event updates.
Numbers are measurements on this shared machine, not CI limits.

| Lanes | Usage ops/s | Usage us/op | Thread ops/s | Thread us/op | Peak RSS MiB |
| ----- | ----------- | ----------- | ------------ | ------------ | ------------ |
| 1     | 1,922,046   | 0.52        | 2,151,925    | 0.46         | 103.3        |
| 16    | 1,962,160   | 0.51        | 2,347,226    | 0.43         | 103.7        |
| 64    | 1,951,774   | 0.51        | 2,329,624    | 0.43         | 103.7        |

The added lifecycle benchmark runs 10,000 revival/check cycles at 64 lanes.
Unrelated lane starts remain pending; each cycle reopens a leaf, invalidates
ancestor checks and completes the fresh check chain. It retains no history.

| Depth | Cycles/s | us/cycle | Peak RSS MiB |
| ----- | -------- | -------- | ------------ |
| 1     | 45,452   | 22.00    | 104.5        |
| 8     | 9,809    | 101.95   | 122.3        |

Ordinary facts update counters/lookups in O(1). Parent propagation is bounded
by depth 8; rare lifecycle cleanup scans at most 129 current intents per lane
rather than history. Snapshot validation, pick and cancellation scan capped
active state. No output stream or event history is retained.
