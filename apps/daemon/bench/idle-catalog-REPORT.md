# Idle workspace catalog investigation

Issue: [#889](https://github.com/arpan404/ace/issues/889). Baseline: `67fa95d4e`.
Both implementations used macOS 26.7.2 arm64 and the app's bundled Node 24.13.0
runtime, executing the same source harness in their own checkouts. Temporary
HOME/ACE_HOME, an empty PATH and no inherited configuration prevented provider
CLI or model requests. The installed daemon was only inspected with `ps` and
`sample`, without a debugger, restart or reading its data/log files.

Eight workspace catalogs remained subscribed on a real local WebSocket. Each
workspace contained one prompt. A temporary SQLite store held 256 manual
automations with approximately 128 KiB prompts (about 32 MiB total). Workspace
paths were canonicalized, and the harness verified workflows were visible in
all eight catalogs before measuring. No workspace files changed during the
window. Startup/seeding preceded a ten-second warmup.

| Final 60-second window                          |    Baseline |       Fixed |
| ----------------------------------------------- | ----------: | ----------: |
| Process CPU, one core, including workers        |     101.14% |       0.84% |
| Catalog pushes                                  |       3,390 |           0 |
| Maximum event-loop delay                        |      427 ms |       16 ms |
| p99 event-loop delay                            |      350 ms |       12 ms |
| Daemon drift monitor maximum, including startup |      317 ms |      105 ms |
| Daemon >=1-second stalls                        |           0 |           0 |
| Catalogs with visible seeded workflows          |           8 |           8 |
| One-minute host load, start → end               | 7.86 → 6.98 | 6.83 → 6.68 |

[Raw results](idle-catalog-results.json) retain elapsed time and unrounded values.
The process CPU total comes from `process.cpuUsage()`, divided by actual monotonic
elapsed time. The event-loop histogram has 10 ms resolution and covers only the
window; the daemon's own monitor samples 500 ms drift from startup and logs delays
of at least one second. No V8 profiler was active during this comparison.

The broad test workload and browser reruns had exited before the final comparison.
Each window's start/end one-minute load was below the repository's existing
threshold of 9; five/fifteen-minute averages still reflected earlier validation.
This is a targeted workload comparison, not a full performance-gate pass or proof
that every cause of CPU use in the installed application is resolved.

## Confirmed mechanism

`CommandFiles.start()` installed a permanent 250 ms interval per context and
optional plugin index. `reconcile()` always advanced and notified subscribers,
even with no changed metadata or discovery jobs. The library expired `extrasAt`
on each notification, defeating its 30-second cache. Socket subscriptions reread
and serialized catalogs; async refresh changed `stale`, so unchanged entries
still produced socket pushes.

The expensive synchronous continuation was the automation catalog projection:
`services/commands.ts` called `AutomationService.list()`, which decoded all prompt
bodies through `AutomationStore.jobs()` before filtering by workspace/provider.
A separate V8 profile attributed 41,748 self samples to that generator, versus
6,041 GC and 396 idle samples. A native ten-second `sample` independently showed
the main thread in JSON parsing, SQLite and iterator consumption. A full
filesystem body rescan was unnecessary to reproduce the problem.

Earlier diagnostic runs on a busy host reproduced a 1,842 ms maximum event-loop
delay and an isolated daemon log warning at `delayMs: 1656`. A fixture review found
that `/tmp` versus `/private/tmp` spelling hid those runs' seeded workflows after
the full prompt reads. Those runs identify the wasteful global read path; their
CPU numbers are excluded from the headline comparison. The final fixture uses
canonical paths and verifies visibility. Native sampling of the fixed process
predominantly waited in `kevent`. Sampling stacks does not establish the number
of stat completions per second. Live packaged-daemon CPU observations occurred
during an active session and are not used as an idle baseline.

## Coverage and tradeoff

The original code fails the unchanged-recovery notification test and real socket
idle-publish test. Real edits still update commands and socket catalogs. An
eight-context test checks one active recovery timer, increasing quiet delays,
native watcher wakeup and shutdown disposal. Existing recovery tests cover missed
edits, deletion, missing roots and bounded discovery. Automation tests cover
metadata filtering, changes, disabling, deletion and reopening without validating
unrelated prompt/polling payloads.

Recovery rotates one bounded batch across the library and backs off to five
seconds when quiet. Native edits retain the independent 30 ms debounce. Silent
watch loss takes longer to repair: with eight contexts and eight plugin indexes,
an index may wait 80 seconds between fallback batches; a full ring needs multiple
batches. [ADR 0039](../../../docs/adr/0039-commands-and-prompts.md) records that
tradeoff. The first automation metadata cache fill still scans bounded stored
definitions. This change does not alter UI animations or list rendering.

## Validation and blockers

- All 219 targeted tests pass across commands, automations and daemon catalog
  sockets. Formatting, lint, protocol documentation, file size, dependency checks
  and incremental typechecking pass. The corrected benchmark also passes its
  workflow-visibility assertions in both implementations.
- `bun run check` recorded 39 web and 22 process test failures before the remaining
  broad run was interrupted after the owner chose to keep this PR scoped. It
  exited 130; remaining suites were not completed. Full repository validation is
  **not green**.
- The first New thread timeout and all five CLI-filter failures also reproduce on
  unchanged baseline `67fa95d4e`. The review-workflow socket-close failure passes
  when rerun alone. All eleven missing-browser failures pass with
  `PLAYWRIGHT_BROWSERS_PATH=/Users/lucifer/Library/Caches/ms-playwright`: seven
  measurement tests and four IndexedDB outbox tests. Retention timeout, lifecycle
  orphan-group, browser guardian cleanup, plugin response validation and CLI-chat
  failures remain unresolved outside this PR's scope.
- Separate `bun run check:perf` passes the idle import guard, defers daemon timing
  on host load, then fails web bundle budgets. Baseline reproduces identical byte
  failures, including initial JS 319.16 KiB / 270 KiB and first screen 616.91 KiB /
  405 KiB. Later performance checks did not run. No budgets or timeouts were relaxed.
