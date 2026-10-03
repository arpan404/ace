# Daemon startup regression review

The owner's merge-only execution rule permits targeted tests for merge conflicts.
After merging origin/main 41df1b1d, 20 tests passed across these five files:
`composition.process.test.ts`, `startup.process.test.ts`,
`browser-pi-mcp.process.test.ts`, `browser-backend.server.process.test.ts`, and
`browser-provider-mcp.process.test.ts`. The new composition regression uses the
public daemon/socket API, applies a real git patch from a finished fork and invokes
the composed browser MCP toolkit. It guards missing or late transitions setup and
missing browser-toolkit registration. The Pi fixture now carries the service abort
signal; startup fixtures launch temporary modules so Node workers do not inherit
an eval-only `--input-type` flag.

All other tests, baseline failure checks and mutations are **not executed (tests
run at merge)**. No full suite, benchmark, standalone daemon timing or doctor probe
was executed. Current-head latency and RSS still **need run at merge**.

The source entry point is `node apps/daemon/src/cli.ts start`, also exposed through
`bun run --filter @ace/daemon dev`. The root package has no `daemon` script.

## Measured cause

The orchestrator measured main with a fresh ace home and large real provider
histories. Its endpoint appeared after 26–28 seconds. The main thread was idle
for roughly 24 seconds while a history worker sampled native sessions; reported
RSS was around 600 MB. These measurements were supplied by the orchestrator,
not reproduced locally. The previous revision of this branch published an
endpoint in about 5 seconds, but still withheld later feature services behind
the scan; that number does not establish a root-cause fix.

On the starting main, `apps/daemon/src/history.ts:64` awaits `service.scan()`
before returning from `openDaemonHistory`. `services/history.ts:7` awaits that
opening call in serial composition, preventing models, notifications and usage
from opening until the full native inventory finishes. Index opening also
swept all cached source rows synchronously in `packages/history-import/src/catalog.ts:49`.
The worker rejected list requests during scans. Together these tied startup and
history availability to user-history size.

The fix opens the index without awaiting scanning, filters registered homes
before serving rows, processes inventory in a background worker, serves committed
WAL snapshots during scans, and exposes progress and failures. Per-file stamps
persist size, mtime and fingerprint; unchanged content is not reread. Four samples,
128 KiB per sample, bounded SQLite pages and stream windows, worker heap limits
and cancellation constrain work independently of transcript size. Actual RSS and
current-head timings remain **needs run at merge**; heap limits alone do not prove RSS.

The orchestrator also measured e8583d35 at **1.7 s first start** and **1.5 s
second start**. This review revision removes another listener-blocking traversal
and adds no data-sized startup work. Confirming that it preserves or improves
those timings, and flat scan RSS, **needs run at merge**. No benchmark was run.

Doctor's original `packages/diagnostics/src/probes.ts:60` searched only PATH.
Line 67 required the entire output to match `git version [\\w.+-]+`, rejecting
Apple Git's distribution suffix. The fix resolves system locations when PATH has
no git and accepts valid suffixed version output while rejecting unrelated output.

Composition also awaited plugin garbage collection and account-home validation.
Those now run as observable warmup. Commands wait for validated homes in background
initialization, and assignments remain gated. Context legacy storage accounting
now recovers in yielded batches before admitting uploads. Usage was already
background backfill; model discovery is lazy and its saved cache is capped.
Notification replay also runs as background warmup after the worker-ready handshake.

## Review fixes

At e8583d35, `catalog.ts:208,222,231,264,276` committed ordering recency before
updating JSON summaries and built cursors from the latter. Aggregation now updates
both atomically; cursors use selected ordering columns. Gated public reads check
pagination and cancellation, and an old inconsistent persisted-index fixture
checks compatibility before a new scan runs.

`services/files.ts:51` awaited retention sweeping before the listener. A moved
expired upload sent `uploads.ts:186-201` through the workspace inventory.
Sweeping/support registration now run as cancellable `files` warmup. A real
2,000-file gitignored workspace, an expired moved upload and a filesystem gate
check endpoint/request availability, abort, debt accounting and later recovery.

`index.ts:168,172` published before optional initialization, but `cli.ts:102`
installed shutdown handlers after awaiting it. Signals now have an owner before
startup; abort interrupts initializer bounds and closes resources. A real CLI
process receives SIGTERM after endpoint discovery while its notification cursor
handshake is explicitly held, before stdout readiness. Endpoint removal and
reopening the same home observe cleanup.

Large-history tests gate worker progress acknowledgements. Scan status no longer
depends on 6,000 files taking a particular duration. RSS samples are requested at
boundaries and emitted at progress, with no required number of 50 ms samples.
Sampling byte budgets account for the eight large files individually. Models and
usage requests replace store-file assertions; notification requests must persist
the selected preference. Healthy notification readiness uses a startup status
observer instead of 20 ms polling. Plugin maintenance has a real accepted live
version whose installed content must remain usable after garbage collection.

## Behaviour tests and mutation cases

Mutation cases below are **not executed (tests run at merge)**. Test execution is
limited to the five conflict-related files listed above; all other tests remain
**not executed (tests run at merge)**. Main failure predictions come from static
review and **need run at merge**.

| Test                                                                                                                          | Mutation cases it is designed to kill                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `composition.process.test.ts`: real socket fork/patch merge and browser MCP call                                              | Omit transitions setup; initialize transitions after engine; omit browser before MCP; drop toolkit registration         |
| `history-startup.process.test.ts`: 6,000 files, eight sparse 64 MiB sessions; endpoint and requests within 8 s while indexing | Await scan during opening; withhold later services; block list/status behind scan; report false ready                   |
| Same: persisted list during second start; stats show only two changed/new reads                                               | Lose file stamps across restart; reread unchanged content; lose cached visibility; misreport content reads              |
| Same: RSS at explicit boundaries/progress, growth under 160 MiB; each large sample capped at 128 KiB                          | Read full files; unbounded concurrent samples; retain decoded history; exceed bounded sample windows                    |
| Same: shutdown during indexing exits within 2 s and reopens its home                                                          | Ignore cancellation; leave progress waiters blocked; wait for complete scan on shutdown; leak worker/lock               |
| `scanning-reads.process.test.ts`: read saved sessions at a held worker progress boundary                                      | Reject reads during scan; queue reads behind scanner                                                                    |
| Same: closing releases a paused scan and retains saved index                                                                  | Leave progress acknowledgement awaited; lose committed rows on cancellation                                             |
| `scanning-pagination.process.test.ts`: held aggregation, pagination, abort and persisted reads                                | Split recency/summary updates; derive cursors from stale JSON; drop middle sessions; corrupt committed recency on abort |
| `files-startup.process.test.ts`: held relocated-upload cleanup, real ignored inventory and admission recovery                 | Await sweep before binding; discard abort; refund unremoved debt; drop later cleanup                                    |
| `startup.process.test.ts`: SIGTERM after endpoint discovery before stdout readiness                                           | Register signals only after startup; omit initialization abort; retain endpoint or lock                                 |
| `client/history.process.test.ts`: correlated parallel reads and observable scan completion                                    | Lose request IDs; fail concurrent status/list reads; ignore progress events; acknowledge admission as completion        |
| `accounts/startup-readiness.process.test.ts`: assignments remain gated until canonical homes are ready                        | Assign before validation; skip canonicalization; never open admission after validation                                  |
| `plugins/startup-readiness.process.test.ts`: index opens while another process owns maintenance lock                          | Acquire cleanup lock during index opening; omit maintenance; remove live versions                                       |
| `context/startup-readiness.process.test.ts`: legacy accounting still enforces occupied global bytes                           | Admit writes before migration; omit pending reservations from recovered totals                                          |
| `startup.process.test.ts`: fresh source home, ready notifications/engine, authenticated requests and shutdown                 | Withhold endpoint; await lifetime loop; always degrade notifications; leak endpoint                                     |
| Same: unresponsive notification worker degrades while daemon serves                                                           | Remove named deadline; report wrong service; publish uninitialized worker; fail whole daemon; leak worker               |
| Same: unresponsive engine discovery                                                                                           | Bound only notifications; report stalled engine ready; drop fallback; accept commands without engine                    |
| `notifications-readiness.process.test.ts`: offline delivery remains pending after readiness                                   | Await transport acceptance as readiness; lose durable replay coverage                                                   |
| `doctor-git.process.test.ts`: empty PATH and Apple Git suffix                                                                 | Remove system fallback; restore suffix-free matcher; rely on login-shell PATH                                           |
| Same: unrelated version output                                                                                                | Accept any successful executable as git                                                                                 |

The large-history daemon tests assert scan status and persisted visibility while
scanning, so early endpoint publication alone cannot satisfy them. Existing socket
history tests await indexing explicitly before importing their fixtures. Healthy
startup uses a status observer to await warmup and requires notifications to reach
ready. Existing warm-scan read tracing independently observes content I/O in addition to scan stats.
The unrelated-version case provides additional coverage; main already rejects that
output by source inspection. New indexing/readiness regressions still need run at merge.

Required static checks: `bun run typecheck`, `bun run lint`, `bun run fmt`,
`bun run check:size`, plus regenerated protocol documentation. Only the five named test files ran under the merge-conflict exception; no full
suite, CI watch or `bun run check` is included. Current-head timing, source CLI reproduction and RSS
confirmation remain merge-time work under the final owner rule.
