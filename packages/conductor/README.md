# Conductor

Conductor turns a goal into a dependency-ordered project, with worker lanes, independent reviews, fix forks, account migration and verified integration. The engine, accounts, git, forge and orchestrator packages plug into narrow ports. This package does not launch provider CLIs by itself.

## API

`start(runId, spec, environment)` and `reduce(state, fact, environment)` are pure. They return the next state and effects. `environment` supplies time, unique effect/lane ids and unique UUID agent ids. `State` validates a restorable snapshot. `ConductorPlan`, `ConductorBrief`, `ConductorReview` and `ConductorSpec` are schema-only exports from `@ace/protocol`.

`selectAccount` enforces role/model/provider/account constraints, maximum parallelism, external capacity and quota reservations. `readyWorkstreams` returns ready ids in priority order. Dependencies are ready after their integration checks pass. Review/fix work gets slots before new workers. A reviewer prefers another provider, then another model, falling back to the configured worker model only if necessary.

`threadObservation` maps canonical whole-thread status from core into a lane fact. It never treats an individual turn end as completion or a transient rate-limit wait as exhausted subscription quota. Confirmed exhaustion arrives separately as `usage_limit`. Every lane artifact and status includes its generation. `nextDeadline` supplies the daemon's next timer deadline. The daemon feeds activity from the engine, not files, and supplies `tick` when the timer fires.

`progress(state)` gives the plan/DAG, current lanes under the root, quota reservations, review summaries, integrated revisions and open user gates. `gateRequest` maps a gate into ace's existing approval shape. Budget and deadline approval also need an increased budget or a future deadline. Rejecting any gate cancels the run. Escalation approval requests another attempt; it never changes a failed review into a pass.

## Durable execution

`ConductorStore(path)` owns SQLite tables with the `conductor_` prefix. It commits the snapshot, input receipt and pending effects together. It reuses statements and keeps incremental receipt/outbox counters. `create`, `apply`, `complete`, `load`, `pending` and `delete` are its public operations. Delete requires a terminal run and cascades through receipts and effects. The caller controls retained run count and storage retention.

`ConductorDriver(store, executor(ports), environment)` accepts parsed `conductor.start/approve/pause/resume/cancel` commands, canonical facts and a bounded `drain`. Use one driver per run. Facts may arrive while an effect awaits I/O; only one drain can run at a time. Pause holds new launches/migrations/integration. Cancel cascades stops, suppresses pending merges, and still verifies a merge that already happened. The run stays cancelling until its trees and integration settle.

After restart, reopen the store and drain. Failed execution leaves the same intent pending. Every port operation must durably deduplicate by the supplied key, including preparation, root attachment, session fork/migration, merge and check. A crash after external success but before acknowledgement replays that key. The store cannot make an external process or forge operation exactly once by itself.

The orchestrator must attach a lane before the engine starts it. Git preparation uses a worktree/branch isolated for that lane. The engine owns complete source history and must quiesce a completed lane's session before publishing terminal completion; later forks use that retained history. Accounts migration preserves that history and lane identity, changes generation, and fences old session messages. Gate opening must persist an ace interaction and notification intent together. The daemon adapter maps the first interaction answer into `conductor.approve` with its receipt. Existing daemon stubs return `not_implemented` until these ports are wired.

An account snapshot's `externalActive` excludes Conductor-owned lanes. `quota` is the remaining allowance before the outstanding Conductor reservations. Completing a reservation debits its configured quota estimate locally. A fresher snapshot replaces that estimate. Model `cost` is a conservative reservation per launch/migration, in the same currency/unit as the budget. These are admission estimates, not a billing meter. A same-account quota reset resumes without charging another launch; migration reserves a new launch cost.

`PR-only` opens a PR and checks its CI. A dependency can proceed after that CI passes, and git preparation must base dependent work on verified dependency branches. The mode leaves merging the PR to the user/forge policy and names this explicitly in progress. Local integration is serial and checks every merged revision. Trivial conflicts fork an integrator; other conflicts fork the owner. Both return through review before trying integration again.

## Bounds and performance

Plans have at most 256 workstreams and a 1 MiB artifact limit. Reviews have at least 15 distinct mutations and a 64 KiB artifact limit. Each workstream retains at most 24 review summaries and the latest full report. The engine retains complete session history separately. Completed reviewers/planners leave scheduling indexes; only the current worker session per workstream remains. Accounts and parallel lanes cap at 64, gates at 512, receipts at 65,536 per run, and pending effects at 1,024. Capacity exhaustion applies backpressure rather than eviction of replay receipts. Artifact strings and executor result batches are also capped by schemas.

Ordinary status updates copy only the bounded current lane index. Scheduling scans the bounded current DAG/accounts, never transcripts or receipt history. Snapshot persistence is deliberately a bounded control-plane operation. Provider deltas do not enter Conductor. Port adapters stream large logs and keep only artifact evidence here.

## Verification

Run `bun run test packages/conductor` for the public behaviour tests and the six-workstream simulation. The simulation migrates one account-limited lane with history, fails a review twice before passing, routes a conflict through an integrator, answers an exhausted-review escalation and reopens SQLite mid-run. Store tests use actual temporary SQLite files and explicitly coordinated promises for in-flight cancellation, without sleeps.

Run `bun run --filter @ace/conductor bench` for non-gating status, DAG and SQLite measurements. `python3 packages/conductor/bench/mutations.py` applies twelve deliberate production mutations, requires failing assertions, restores each source file in `finally`, and records the killed tests in `bench/mutation-results.json`. Run it with no other process editing these files. Full repository validation is `bun run check`.
