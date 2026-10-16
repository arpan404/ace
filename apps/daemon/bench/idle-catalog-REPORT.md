# Idle workspace catalog investigation

Issue: [#889](https://github.com/arpan404/ace/issues/889). Baseline: `67fa95d4e`.
Both implementations used macOS 26.7.2 arm64 and Node 26.7.0. The same source
harness ran from each checkout, with separate temporary HOME/ACE_HOME, an empty
PATH, no inherited configuration, and no provider CLI or model requests. Eight
workspace catalog subscriptions remained open on a real local WebSocket. Each
workspace contained one prompt. A temporary SQLite store contained 256 manual
automations with approximately 128 KiB prompts (about 32 MiB total). No files
were edited during measurement. Startup and seeding preceded a 10-second warmup.

| 60-second window                                | Baseline | Fixed |
| ----------------------------------------------- | -------: | ----: |
| Process CPU, one core (includes workers)        |   75.52% | 1.20% |
| Catalog pushes                                  |    1,688 |     0 |
| Maximum event-loop delay                        | 1,729 ms | 69 ms |
| p99 event-loop delay                            | 1,139 ms | 18 ms |
| Daemon drift monitor maximum, including startup | 1,545 ms | 65 ms |
| Daemon >=1-second stalls                        |        1 |     0 |

The app's bundled Node 24.13.0 runtime also ran the same source harness in separate
temporary homes, without modifying or restarting the installed daemon:

| 60-second window on Node 24.13.0 | Baseline | Fixed |
| -------------------------------- | -------: | ----: |
| Process CPU, one core            |   89.86% | 1.37% |
| Catalog pushes                   |    1,881 |     0 |
| Maximum event-loop delay         | 1,008 ms | 25 ms |
| p99 event-loop delay             |   852 ms | 15 ms |

[Raw results](idle-catalog-results.json) retain elapsed time and unrounded values.
The process CPU total comes from `process.cpuUsage()`, divided by actual monotonic
elapsed time. The event-loop histogram has 10 ms resolution and covers only the
measurement window; the daemon's own monitor samples 500 ms drift from startup
and logs delays of at least one second. Its isolated baseline log contained
`Event loop stalled`, `delayMs: 1545`.

These are diagnostic observations on a busy host, not qualified idle-host timing
gate results. Background browser/test activity resumed after an initial test run
was stopped; repository validation also ran on the host. The performance gate
independently deferred daemon timing because host load exceeded its threshold.
The workload itself was idle, and process CPU, socket output and event-loop
delay were measured separately from other processes. A repeat without fully
clearing inherited environment measured 75.06% versus 1.17% CPU, 1,902 versus
zero pushes, and 1,842 versus 31 ms maximum delay. Neither repeat establishes
that every cause of CPU use in the installed application is resolved.

## Confirmed mechanism

`CommandFiles.start()` installed a permanent 250 ms interval for every context
and optional plugin index. `reconcile()` always called `advance()`, which always
notified subscribers, even with no changed metadata or discovery jobs. The
library expired `extrasAt` on each notification, defeating its 30-second cache.
Socket subscriptions then reread and serialized catalogs. Async metadata refresh
changed the `stale` flag, so unchanged entries still produced socket pushes.

The expensive synchronous continuation was the automation catalog projection:
`services/commands.ts` called `AutomationService.list()`, which decoded all prompt
bodies through `AutomationStore.jobs()` before filtering by workspace/provider.
A separate V8 profile attributed 41,748 self samples to that generator, versus
6,041 GC and 396 idle samples. A native 10-second `sample` independently showed
the main thread in JSON parsing, SQLite and iterator consumption. A filesystem
body rescan was unnecessary to reproduce the problem. The fix caches bounded
automation metadata and stops the false invalidations that repeatedly reached it.

The V8-profiled comparison measured 105.73% versus 5.91% CPU and 2,917 versus zero
pushes. Sampling-thread overhead is why those CPU values are excluded from the
headline table. The fixed native sample predominantly waited in `kevent`.
Sampling stacks does not establish a count of stat completions per second.

The installed daemon was inspected only using `ps` and `sample`, without a
debugger, restart or reading its data/log files. Its CPU observations occurred
during an active session and are not an idle baseline. The seconds-long stall
was independently reproduced in temporary daemon logs instead.

## Coverage and tradeoff

The original code fails both the unchanged-recovery notification test and the
real socket idle-publish test. Real edits still update commands and socket
catalogs. An eight-context test checks one active recovery timer, increasing
quiet delays, native watcher wakeup and shutdown disposal. Existing recovery
tests retain missed-edit, deletion, missing-root and bounded-discovery coverage.
Automation tests cover metadata filtering, changes, disabling, deletion and
reopening without validating unrelated prompt/polling payloads.

Recovery rotates one bounded batch across the library and backs off to five
seconds when quiet. Native edits retain the independent 30 ms debounce. Silent
watch loss takes longer to repair: with eight contexts and eight plugin indexes,
an index may wait 80 seconds between fallback batches; a full ring needs multiple
batches. [ADR 0039](../../../docs/adr/0039-commands-and-prompts.md) records that
tradeoff explicitly. This change does not alter UI animations or list rendering.

## Validation

All 219 targeted tests pass across the commands and automations packages and the
daemon catalog socket suite. Formatting, lint, protocol documentation, file size,
dependency checks and incremental typechecking pass.

The full `bun run check` run encounters web test failures. The first New thread
test also times out on unchanged baseline `67fa95d4e` when run alone. A separate
`bun run check:perf` passes the idle import guard, defers daemon timing on host
load, then fails web bundle budgets. The unchanged baseline reproduces the same
byte-budget failures, including initial JS 319.16 KiB / 270 KiB and first screen
616.91 KiB / 405 KiB. No budgets or test timeouts were relaxed. A fully passing
repository check remains outstanding; these results do not claim otherwise.
