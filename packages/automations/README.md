# @ace/automations

Local scheduled and event-triggered agent tasks. The package invokes an engine executor, never a provider CLI. See [ADR 0015](../../docs/adr/0015-automations.md).

## Integration

```ts
import { AutomationService, AutomationStore, createGhClient, nodeTimer } from "@ace/automations";

const store = new AutomationStore(privateStateDirectory + "/automations.sqlite");
const service = new AutomationService(
  store,
  {
    now: clock.now,
    random: random.next,
    id: ids.next,
    timer: nodeTimer,
    executor: engineAutomationExecutor,
    workspace: workspaceChanges,
    onError: reportError,
    onRun: publishCommittedRun,
  },
  createGhClient({ binary: installedGhPath }),
);
service.start();
```

The daemon owns one service and store. Route `AutomationRequest` through existing authenticated, authorized command handling to `service.handle`. The new envelopes are exported by `@ace/protocol`; they are intentionally separate from its existing wire union. Engine and workspace implementations are injected pending those feature merges.

`put`, `remove`, `list`, `trigger` and `inbox` provide the same operations directly. `trigger` takes a durable event key and a bounded string-variable record. The `automation.run` envelope uses its request ID as the manual idempotency key. Retry an unchanged `put` safely; changing a definition starts a new schedule and resets the GitHub baseline. To pause, put the definition with `enabled: false`. Re-enabling starts from the current time.

An executor receives `{ idempotencyKey, automationId, provider, model?, workspace, prompt, worktree }`. Creation must be idempotent by the key. `execute(input, signal)` resolves to `{ threadId, status: "succeeded" | "failed", result }` only when the entire thread tree has settled. Human waits and background tasks keep the promise pending. Rejected creation promises become failed runs. On restart, `recover(key, signal)` resumes monitoring existing work. Return `undefined` only if creation definitely did not happen, so the service can retry with the original input and key. Abort signals release monitoring subscriptions without cancelling the engine-owned thread. The service drops obsolete observers even if an executor ignores cancellation; executors must honor the signal to free their own resources. A recovery error leaves the run active and reports an error; restart/reconcile after the engine is available again.

`WorkspaceChanges.subscribe(workspace, paths, receive)` returns an unsubscribe function. The workspace service supplies durable `{ key, variables }` events and owns watcher backpressure, glob matching and rename handling. `receive` resolves after durable admission, not thread completion. Repeated delivery is safe. Configuration prepares subscriptions before committing, so a failed replacement preserves the old configuration and watcher. Cleanup attempts every unsubscribe independently and reports failures. A typical template is `Review changes in {{path}}` with a `path` variable supplied by the workspace integration.

`onRun` receives committed records. The inbox pages newest-first with a numeric `before` cursor and a maximum of 100 rows. It includes failed template rendering and arrivals skipped at capacity. Stopping cancels the one scheduler timer, subscriptions and in-flight gh requests. It preserves unfinished runs for recovery. `settled()` waits for admitted operations; it can remain pending while an executor awaits a human. After stopping, `settled()` releases its waits even if external monitors ignore cancellation. Stop the service before closing the store. The engine owns thread lifetimes. Lifecycle transitions are serialized: synchronous `start()` calls from cancellation or cleanup callbacks during `stop()` are ignored. Call `start()` after `stop()` returns to restart. A stop requested during startup disables admission immediately and cleans up when startup finishes.

## Calendar behavior

All schedules carry an IANA timezone and a minute-aligned epoch `startAt`. The supported grammars and limits are explicit in ADR 0015. Missing wall times and invalid calendar dates are skipped; repeated wall times run once at the first instant. Cron's fold behavior deliberately differs from traditional cron, which runs twice.

`compileSchedule(schedule).next(after)` returns the next instant strictly after the cursor, or `undefined` when COUNT/UNTIL ends the rule. `seek(after, previous?)` returns `{ at, ordinal }`. The service persists this cursor, so advancing counted schedules examines new occurrences instead of rereading history. An initial COUNT lookup or counted downtime recovery enumerates occurrences with a one-million candidate budget. Other lookups jump to the cursor's civil date. Date search has a 400-year bound. Exhaustion is an explicit error.

Jitter is additive and persisted per occurrence. Its upper bound is the smaller of `jitterMs` and the time remaining before the following nominal occurrence. This keeps large jitter from swallowing later scheduled runs. The last occurrence uses the configured maximum. The downtime policy uses the jittered deadline. `skip` advances beyond startup time; `run_once` runs the first persisted overdue occurrence once. Both coalesce old occurrences and advance beyond the current time. Overlapping arrivals are recorded as skipped. There is no waiting queue. Each automation allows 1 through 32 active runs, with a host cap of 256. At most 1,000 definitions are loaded.

## GitHub behavior

`pr_changed` covers newly opened PRs and updates. `ci_failed` uses failed Actions workflow runs, optionally restricted to `pullRequest`. `review_comment` uses inline PR review comments, with the same optional PR filter. `issue_labelled` fires only for newly present labels, optionally matching `label`. Variables include `repository`, `url`, `number`, `title`, `body`, plus `label` or `pull_requests` where relevant. The CI `number` is the workflow run ID; `pull_requests` contains comma-separated associated PR numbers.

The first poll establishes a baseline. Polling cannot recover changes that appear and disappear entirely between requests. Resource ID and updated timestamp identify an event. The service checks configuration revision before every delivered event and snapshot commit, including edits made by `onRun`. ETags and per-page snapshots survive restart. Unchanged conditional pages retain their cached data; an entirely unchanged response avoids snapshot rewriting. Pages must stay within the configured repository and GitHub API origin. GitHub Enterprise hosts are not yet supported.

Limits are 100 resources per page, 20 pages, 2,000 emitted events per poll, and 2 MiB total child output per request by default. Each request has a 30-second deadline and cancellation. `createGhClient` accepts an injected `spawn` boundary, defaulting to the shared POSIX process-group supervisor. Cancellation rejects immediately, destroys pipes and terminates the owned process group. Noncanonical endpoints with dot segments fail before spawning. Four sources can poll concurrently. Excess sources remain due on disk; a separate schedule index keeps their waits from delaying scheduled tasks. Overflow fails visibly through `onError` and retries at the next interval; it does not silently truncate. Large repositories need narrower endpoint queries in a future extension. Run history and event keys remain on disk for audit and deduplication; memory does not cache history. Retention is a separate policy decision.

Definitions and deadlines occupy small SQLite rows. Snapshots occupy a separate table, migrated atomically from the original inline format at startup. Listing and admission never load snapshots; startup iterates metadata and reads only schedule cursors. Each GitHub poll loads its own snapshot once.

## Verification

The tests exercise the public API, temp SQLite, fake clocks/timers, executor fakes and real fake-gh processes. The malformed-resource polling test uses an injected response instead of starting a process just to validate JSON. Real fake-gh tests continue to cover HTTP parsing, conditional requests, restart and cancellation.

The repository owner now runs tests once at merge time. During feature work, run only `bun run fmt`, `bun run lint`, `bun run typecheck` and `bun run check:size`. New behavior tests and mutation cases remain pending execution at merge. Historical benchmark measurements and completed test runs are recorded in `VERIFICATION.md`; do not rerun tests or benchmarks during this workflow.
