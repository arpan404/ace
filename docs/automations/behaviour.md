# Automations: observable behaviour and invariants

The contract of `@ace/automations` (the scheduler, triggers, durable runs and webhooks) and of
the daemon's automation executor and run monitor (`apps/daemon/src/automation-*.ts`). Written
against `ace/daemon-rust-rewrite` at 42386d3751.
[ADR 0225](../adr/0225-device-screen-automation-and-mcp-control-planes-stay-typescript.md) decides
what moves to Rust; [porting-guide.md](porting-guide.md) says how. Product contract:
[ADR 0015](../adr/0015-automations.md) and [ADR 0173](../adr/0173-automation-webhooks-through-ace-cloud.md);
`packages/automations/README.md` describes the calendar and GitHub rules in prose and
`VERIFICATION.md` records the mutation runs.

## 1. What it is and where its work runs

- **The package** (3,504 source lines, 23 modules) is pure decisions (`decisions.ts`,
  `recurrence.ts`, `calendar.ts`, `grammar.ts`, `github.ts`) around one service
  (`AutomationService`, `service.ts:52`) and one store (`AutomationStore`, `store.ts:56`), a
  SQLite file of its own opened through `@ace/provider-kit/sqlite` (`store.ts:2`), so the store's
  one-SQLite-library rule (ADR 0222) covers it.
- **Two instances run in the daemon**: the person's (`automations.sqlite`,
  `apps/daemon/src/services/automations.ts:22`) and the one for automations agents made from
  threads (`agent-automations.sqlite`, `apps/daemon/src/agent-control/owners.ts:41`, zero jitter,
  its timer on the engine clock).
- **The daemon side** (2,452 source lines in 11 modules) is the executor and monitor: `automation-executor.ts`
  (admission gate, launch settings), `automation-run-executor.ts` (where a run's message goes),
  `automation-run-record.ts` (one durable record per run), `automation-run-monitor.ts` (follows
  the run's turn and tree until it is over), `automation-run-facts.ts` (indexed reads of the turn),
  `automation-run-rules.ts` (pure: when a run is over, how it went, what stopping means),
  `automation-workspace.ts` (file triggers), `automation-webhooks.ts` (hooks through ace cloud).
- **I/O**: one timer per service (`TimerDriver`, `contracts.ts:50`), `gh` child processes for
  GitHub polling (`createGhClient`, `gh-process.ts:24`), the workspace watcher, webhook requests
  forwarded by the relay.

## 2. Public surface

`package.json` exports `.`, `./recurrence` and `./calendar`. Callers outside the package use
these 16 names:

| Export                        | Defined at                     | Callers outside (prod / test) | Example callers                                                                                                                                                     |
| ----------------------------- | ------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Admission`                   | `src/contracts.ts:80`          | 1 / 0                         | `apps/daemon/src/automation-executor.ts:10`                                                                                                                         |
| `AutomationExecutor`          | `src/contracts.ts:32`          | 3 / 0                         | `apps/daemon/src/agent-control/owner-thread-executor.ts:2`, `apps/daemon/src/automation-run-executor.ts:1`, `apps/daemon/src/automation-executor.ts:10`             |
| `AutomationService`           | `src/service.ts:52`            | 5 / 0                         | `apps/daemon/src/automation-lifecycle.ts:1`, `apps/daemon/src/agent-control/thread-automations.ts:1`, `apps/daemon/src/agent-control/owners.ts:10`                  |
| `AutomationStore`             | `src/store.ts:56`              | 4 / 1                         | `apps/daemon/bench/idle-catalog.ts:8`, `apps/daemon/src/agent-control/owners.ts:10`, `apps/daemon/src/automation-webhooks.ts:11`                                    |
| `AutomationWebhooks`          | `src/webhooks.ts:57`           | 1 / 0                         | `apps/daemon/src/automation-webhooks.ts:11`                                                                                                                         |
| `ExecutionInput`              | `src/contracts.ts:4`           | 3 / 1                         | `apps/daemon/src/agent-control/owner-thread-executor.ts:2`, `apps/daemon/src/automation-run-executor.ts:1`, `apps/daemon/src/automation-executor.ts:10`             |
| `ExecutionResult`             | `src/contracts.ts:26`          | 3 / 0                         | `apps/daemon/src/automation-run-monitor.ts:2`, `apps/daemon/src/agent-control/owner-thread-executor.ts:2`, `apps/daemon/src/automation-run-executor.ts:1`           |
| `SecretBox`                   | `src/webhook-secret-box.ts:8`  | 1 / 0                         | `apps/daemon/src/automation-webhook-key.ts:12`                                                                                                                      |
| `WorkspaceChanges`            | `src/contracts.ts:53`          | 1 / 0                         | `apps/daemon/src/automation-workspace.ts:5`                                                                                                                         |
| `createGhClient`              | `src/gh-process.ts:24`         | 1 / 0                         | `apps/daemon/src/services/automations.ts:4`                                                                                                                         |
| `nodeTimer`                   | `src/contracts.ts:94`          | 1 / 0                         | `apps/daemon/src/services/automations.ts:4`                                                                                                                         |
| `signWebhook`                 | `src/webhook-signature.ts:46`  | 0 / 1                         | tests only                                                                                                                                                          |
| `webhookSecretBox`            | `src/webhook-secret-box.ts:27` | 1 / 0                         | `apps/daemon/src/automation-webhook-key.ts:12`                                                                                                                      |
| `/calendar civilStamp`        | `src/calendar.ts:10`           | 1 / 0                         | `packages/ui-core/src/automations/schedule.ts:2`                                                                                                                    |
| `/calendar zonedCalendar`     | `src/calendar.ts:32`           | 1 / 0                         | `packages/ui-core/src/automations/schedule.ts:2`                                                                                                                    |
| `/recurrence compileSchedule` | `src/recurrence.ts:72`         | 5 / 1                         | `packages/ui-core/src/automations/schedule.ts:3`, `packages/ui-core/src/automations/schedule-validate.ts:1`, `packages/ui-core/src/automations/trigger-health.ts:2` |

`compileSchedule` and the calendar helpers also run outside the daemon: `packages/ui-core`
(schedule editing and trigger health in the web and iOS apps) and `packages/fake-daemon`. They
must stay JavaScript there whatever the daemon runs.

`AutomationService`'s methods are the contract its callers and tests use: `start` (`:102`),
`stop` (`:210`), `settled` (`:234`), `put(input, expectedRevision?)` (`:287`), `remove`
(`:423`), `setEnabled` (`:432`), `list` (`:437`), `catalog` (`:440`), `inbox` (`:443`),
`trigger` (`:450`), `retry` (`:703`) and `handle(request)` (`:800`), which answers every
`AutomationRequest` envelope of `@ace/protocol`. The executor contract is
`AutomationExecutor` (`contracts.ts:32`): `execute(input, signal)` resolves only once the whole
thread tree has settled; `recover(key, signal, input?)` resumes following existing work
(undefined: nothing was sent); `interrupt(input)` resolves once the stop is held durably.

## 3. Behaviour that is contract

### Agent state (priority 1)

- A run is over only when its whole tree is: the turn its message started, every root run after
  it until the next ask, and all work that turn began, delegated threads and background tasks
  included (`automation-run-rules.ts`: `runTreeState` `:45`, `decideRun` `:122`; tree states
  `working`, `needs-human`, `uncertain`, `ok`, `failed`). A human wait or a background task keeps
  `execute` pending. A run is never recorded succeeded while any part of its tree works or waits
  on the person.
- The monitor re-reads its facts every 5 s in case a change came without an event it listens for
  (`reconcileMs`, `automation-run-monitor.ts:26`); each read touches only the turn's own rows
  (`automation-run-facts.ts` header). A stop whose delivery fails is retried 5 times
  (`stopTries`, `:28`) before the run says it can't be stopped.
- Restart: unfinished runs survive `stop` and are recovered by key; `recover` must not send the
  message twice. Creation is idempotent by `idempotencyKey`; the `automation.run` envelope uses
  its request id as the manual key.

### Admission

- Every run of an automation goes into its one thread, so only one runs at a time: a fire while
  one runs waits behind it; one waiting is enough and a further fire is skipped; at ace's running
  limit (256, `decisions.ts:56`) a fire is skipped; a file automation's own edits never start it
  again (`admission`, `decisions.ts:65`).
- The daemon's admission gate (ADR 0041): while any hold turns new work away, the person's pause
  included, a due run is skipped ("Skipped: new work was paused.", `contracts.ts:91`) and Run now
  is refused ("New work is paused. Resume new work in ace to continue.", `:93`); waiting runs
  stay waiting and start when it reopens. An organization's host runs no automation yet
  (`orgHostAutomationRefusal`, `apps/daemon/src/automation-executor.ts:44`). These strings are
  contract.
- Webhook runs carry an access ceiling (ADR 0173, decision 9): a thread grown wider since is left
  for a new one at the automation's access (`withinCeiling`, `automation-executor.ts:191`).
  Webhook requests are rate-limited to 60 a minute per key, 2,048 keys
  (`webhookRate`, `automation-webhooks.ts:52`); signatures are verified with a tolerance
  (`webhookToleranceMs`) and at most 16 signatures per header.

### Calendar

- Every schedule carries an IANA timezone and a minute-aligned epoch `startAt`. Missing wall
  times and invalid dates are skipped; a repeated wall time (autumn fold) runs once, at the first
  instant, unlike traditional cron. COUNT and UNTIL are inclusive; monthly day 31 never spills
  into short months. Zone rules come from the runtime's ICU through `Intl.DateTimeFormat`
  (`calendar.ts:34`).
- `compileSchedule(schedule).next(after)` is the next instant strictly after the cursor, or
  undefined when the rule ends; `seek` returns `{at, ordinal}` and the service persists it, so
  counted schedules never reread history.
- Jitter is additive, persisted per occurrence, and capped by the time to the next nominal
  occurrence. Downtime policy `skip` advances past startup; `run_once` runs the first overdue
  occurrence.

### Scheduling, cancellation and lenient decoding

- **One timer per service**, armed for the earliest deadline the store's index returns
  (`nextScheduled`, `store.ts:314`); arming replaces the previous timer (a mutation test pins it).
  Startup iterates job metadata and reads only schedule cursors; listing and admission never load
  poll snapshots.
- `stop` cancels the timer, subscriptions and in-flight `gh` requests and keeps unfinished runs
  for recovery. A cancelled `gh` call rejects at once, destroys its pipes and ends its process
  group. Each request has a 30 s deadline and 2 MiB of output.
- GitHub limits: 100 resources a page, 20 pages, 2,000 events a poll. The first poll is a
  baseline. ETags and per-page snapshots survive restart; the configuration revision is checked
  before every delivered event and snapshot commit, so an edit stops the rest of an old batch.
- Corrupt rows are isolated: an unreadable definition or poll state never stops listing,
  restarting or other automations (`isolateJob`, `unreadable` sets in `store.ts`).
- Permissions are the run's provider's: a run starts with the automation's access mode; ace adds
  no approval of its own.

## 4. Measured (2026-11-23, M4 Max, load average 50 to 90)

Existing benches (`bun run --filter @ace/automations bench`'s files, run with Bun): weekday RRULE
18.5 µs, five-minute cron 18.0 µs, counted cursor advance 11.4 µs, indexed next deadline over
1,000 jobs 14.3 µs, indexed inbox page over 15 k records 51.6 µs, 100-PR snapshot with one change
7.1 µs; durable admission 232 to 449 µs, file admission plus executor plus outcome 597 µs; a full
poll of 1,000 PRs with 8 KiB bodies plus admission 53 ms (1 change) to 432 ms (1,000 changes),
mostly building, comparing and storing 8 MB of resources; one supervised `gh` process with a
64 KiB answer 41.9 ms; restart plus recovery plus cancellation of one pending run 33.9 µs.
The daemon's per-run monitor reads every 5 s. Timers: one per service.

## 5. The tests that guard this, and which carry over

Classes as in [docs/devices/behaviour.md](../devices/behaviour.md) §5. No file is live.

### (a): 25 files in `packages/automations/src/`

`admission`, `audit-reliability`, `cancellation`, `cas`, `durability`, `gh-process.process`, `github.process`, `jitter`, `lifecycle`, `metadata`, `monitoring`, `outcome-recovery`, `paused`, `polish`, `queue`, `recurrence`, `revision`, `run-options`, `service`, `startup`, `teardown`, `trigger-readiness`, `watchers`, `webhook-secret-box`, `webhooks`.

### (b): 2 files

| File                | Internal it reaches                                                              |
| ------------------- | -------------------------------------------------------------------------------- |
| `webhook-body`      | `webhook-body.ts` `webhookVariables` (a request body to template variables)      |
| `webhook-signature` | `webhook-signature.ts` `newWebhookSecret`, `readWebhookHeaders`, `verifyWebhook` |

### In the daemon (`apps/daemon/src/`, 15 files)

| Test files                                                                                                                                                                                                                                       | Class | What it guards                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `automation-durability.process`, `automation-idle.process`, `automation-one-thread.process`, `automation-run-record.process`, `automation-webhooks.process`, `thread-automations.process`, `cli-automation.process`, `cursor-automation.process` | a     | runs through a started daemon: durability across restarts, idle release, one thread per automation, run records, webhooks, agent-made automations, `ace automation`, Cursor runs |
| `automation-workspace.process`                                                                                                                                                                                                                   | a     | file triggers through `automationWorkspace` with the real files tool                                                                                                             |
| `automation-run-rules`                                                                                                                                                                                                                           | b     | `automation-run-rules.ts` (pure tree and stop rules)                                                                                                                             |
| `automation-org-host`, `automation-run-settings`                                                                                                                                                                                                 | b     | `automation-executor.ts` (org-host refusal, launch settings)                                                                                                                     |
| `automation-webhook-key`, `automation-webhook-reach`                                                                                                                                                                                             | b     | the webhook key box and reachability                                                                                                                                             |
| `automation-workspace`                                                                                                                                                                                                                           | b     | `automation-workspace.ts` reconciliation limits                                                                                                                                  |

Counts: 34 (a) files, 8 (b), 0 (c).
