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

## Mutation audit

Run `python3 packages/orchestrator/bench/mutations.py`. The script applies one
production change at a time, requires a behavioural assertion failure, and
restores the file in `finally`. All 12 were killed and reverted:

| Mutation                                        | Behaviour that failed                          |
| ----------------------------------------------- | ---------------------------------------------- |
| Replace the fanout start prompt                 | All lanes must receive the user's prompt       |
| Disable race winner selection                   | A passing race lane wins and losers cancel     |
| Settle cancellation before its acknowledgment   | Budget cancellation must await stops           |
| Drop the pipeline artifact input                | Review/fix must receive the previous artifact  |
| Allow depth equal to the maximum to spawn again | Nested task past the depth cap is rejected     |
| Change token budget `>=` to `>`                 | Exact budget exhaustion starts cancellation    |
| Accept facts from an old attempt                | Retry ignores old completion and usage         |
| Add cumulative usage as though it were a delta  | Replay cannot double-charge                    |
| Ignore unfinished children when reconciling     | Planner waits for blocked descendants          |
| Skip the optional review predicate              | Passing command without review is insufficient |
| Return no intents on recovery                   | Persisted work must replay with original IDs   |
| Remove the target branch predicate              | Wrong-branch winner application is refused     |

## Non-gating benchmark

`bun run --filter @ace/orchestrator benchmark` uses Node 26.8.1 and 300,000 operations
per path per lane count. Each lane changes thread phase every round, so the
status benchmark includes event emission and counter updates. Both paths parse
the public fact schema. Numbers are measurements on this machine, not CI limits.

| Lanes | Usage ops/s | Usage us/op | Thread ops/s | Thread us/op | Peak RSS MiB |
| ----- | ----------- | ----------- | ------------ | ------------ | ------------ |
| 1     | 2,339,878   | 0.43        | 1,112,479    | 0.90         | 102.6        |
| 16    | 2,352,060   | 0.43        | 2,798,222    | 0.36         | 103.2        |
| 64    | 2,346,952   | 0.43        | 2,709,501    | 0.37         | 103.3        |

Counters and lane lookups update in O(1); child propagation is bounded by depth 8. Snapshot validation, initialization, picking, cancellation and recovery
scan the bounded active state. No output stream or event history is retained.
