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

An executor receives `{ idempotencyKey, automationId, provider, model?, workspace, prompt, worktree }`. Creation must be idempotent by the key. `execute` resolves to `{ threadId, status: "succeeded" | "failed", result }` only when the entire thread tree has settled. Human waits and background tasks keep the promise pending. Rejected creation promises become failed runs. On restart, `recover(key)` resumes monitoring existing work. Return `undefined` only if creation definitely did not happen, so the service can retry with the original input and key. A recovery error leaves the run active and reports an error; restart/reconcile after the engine is available again.

`WorkspaceChanges.subscribe(workspace, paths, receive)` returns an unsubscribe function. The workspace service supplies durable `{ key, variables }` events and owns watcher backpressure, glob matching and rename handling. `receive` resolves after durable admission, not thread completion. Repeated delivery is safe. A typical template is `Review changes in {{path}}` with a `path` variable supplied by the workspace integration.

`onRun` receives committed records. The inbox pages newest-first with a numeric `before` cursor and a maximum of 100 rows. It includes failed template rendering and arrivals skipped at capacity. Stopping cancels the one scheduler timer, subscriptions and in-flight gh requests. It preserves unfinished runs for recovery. `settled()` waits for admitted operations; it can remain pending while an executor awaits a human. Stop the service before closing the store. The engine owns thread lifetimes.

## Calendar behavior

All schedules carry an IANA timezone and a minute-aligned epoch `startAt`. The supported grammars and limits are explicit in ADR 0015. Missing wall times and invalid calendar dates are skipped; repeated wall times run once at the first instant. Cron's fold behavior deliberately differs from traditional cron, which runs twice.

`compileSchedule(schedule).next(after)` returns the next instant strictly after the cursor, or `undefined` when COUNT/UNTIL ends the rule. `seek(after, previous?)` returns `{ at, ordinal }`. The service persists this cursor, so advancing counted schedules examines new occurrences instead of rereading history. An initial COUNT lookup or counted downtime recovery enumerates occurrences with a one-million candidate budget. Other lookups jump to the cursor's civil date. Date search has a 400-year bound. Exhaustion is an explicit error.

Jitter is additive, uniformly drawn from zero through `jitterMs`, and persisted per occurrence. The downtime policy uses the jittered deadline. `skip` advances beyond startup time; `run_once` runs the first persisted overdue occurrence once. Both coalesce old occurrences and advance beyond the current time. Overlapping arrivals are recorded as skipped. There is no waiting queue. Each automation allows 1 through 32 active runs, with a host cap of 256. At most 1,000 definitions are loaded.

## GitHub behavior

`pr_changed` covers newly opened PRs and updates. `ci_failed` uses failed Actions workflow runs, optionally restricted to `pullRequest`. `review_comment` uses inline PR review comments, with the same optional PR filter. `issue_labelled` fires only for newly present labels, optionally matching `label`. Variables include `repository`, `url`, `number`, `title`, `body`, plus `label` or `pull_requests` where relevant. The CI `number` is the workflow run ID; `pull_requests` contains comma-separated associated PR numbers.

The first poll establishes a baseline. Polling cannot recover changes that appear and disappear entirely between requests. Resource ID and updated timestamp identify an event. ETags and per-page snapshots survive restart. Unchanged conditional pages retain their cached data; an entirely unchanged response avoids snapshot rewriting. Pages must stay within the configured repository and GitHub API origin. GitHub Enterprise hosts are not yet supported.

Limits are 100 resources per page, 20 pages, 2,000 emitted events per poll, and 2 MiB total child output per request by default. Each request has a 30-second deadline and cancellation. Overflow fails visibly through `onError` and retries at the next interval; it does not silently truncate. Large repositories need narrower endpoint queries in a future extension. Run history and event keys remain on disk for audit and deduplication; memory does not cache history. Retention is a separate policy decision.

## Verification

`bun run test packages/automations` exercises the public API, temp SQLite, fake clocks/timers, executor fakes and real fake-gh processes. `bun run --filter @ace/automations bench` reports recurrence, snapshot translation, SQLite admission, deduplication, deadline selection and inbox throughput without gating tests on machine timing. Full delivery requires `bun run check`.
