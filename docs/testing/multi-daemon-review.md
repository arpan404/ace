# Multi-daemon review follow-up

The owner requires tests and benchmarks to run only at merge. The regression
tests were written before the runtime fixes. No red/green run, mutation run,
flakiness run or benchmark was executed for this follow-up. All runtime claims
below need run at merge.

## Regression cases

`packages/client-worker/src/machines-review.process.test.ts` exercises the public
pool with real dedicated workers and synthetic fake daemons:

- Crash a host with working facts, reconnect with a held or failed sidebar
  snapshot, keep another host operating, and retain the working row and count
  until a successful authoritative snapshot arrives.
- Delete a device token successfully, fail the following metadata save, and
  reject commands through both the pool and a retained client handle. Preserve
  an offline entry with a storage error. Reconnect requires authorization; retry
  removal completes after storage recovers.
- Reject mismatched command, enqueue, request, browser close, input and ACK
  controls. Both browsers remain readable. Correctly routed close and durable
  archive affect only their target thread. Nested browser-open IDs are checked.

`packages/client/src/machine-threads.test.ts` drives decoded sidebar boundaries
through the public merged-store API. It covers delayed/error-only replacement,
authoritative empty snapshots, throwing change and count observers, complete
multi-row delivery to keyed selections, snapshot ordering, and the shared
4,096-slot listener budget with idempotent release.

The existing host-identity and pool process tests remain the guards for the
review's mutation cases 1–18. Cases 19–22 target the regressions above. The new
ordering and admission cases target ignoring snapshot order, bypassing change
or count admission, leaking slots, and releasing slots twice. Every mutation
case is **not executed (tests run at merge)**. Intended guards are not evidence
that a mutation was killed.

The blocked-worker fixture now uses a shared-memory release signal. The parent
can prove another worker makes progress before releasing the blocked worker.
It no longer depends on a 2-second timed block ending. Operation deadlines still
need serial and concurrent flakiness validation at merge.

## Pool measurements to collect at merge

Run `node packages/client-worker/bench/machines.ts` in an isolated process under
Node 24+. Repeat each scenario at least three times; retain raw JSON and record
machine load, Node version and commit. The benchmark uses public pool APIs,
separate worker threads, fake host catalogs and no provider prompts or user
home. It measures 1, 2 and 3 hosts, each with 100, 1,000 and 5,000 sidebar rows.
For an isolated scenario, append host count and rows, for example
`node packages/client-worker/bench/machines.ts 2 5000`.

Output includes startup time, merged changes/second, command-to-merged p95,
predicate reads per changed row, healthy-host latency while another worker is
blocked, parent heap and process RSS growth. RSS includes worker memory; parent
heap does not. Per-case memory is sampled before/after startup and updates,
not a peak measurement or a leak soak. Use isolated scenario runs or repeat
the entire script to distinguish GC retention between cases from a leak.

Count initialization is outside the delta measurement. Expected predicate reads
are two per replaced existing row, independent of unrelated sidebar history.
Compare p95 and throughput across row sizes at a fixed host count. Collect
worker/process memory after close in a separate soak before asserting leak
safety. Changes/second includes transport, worker mirroring and public command
round trips, so it is not a pure reducer throughput measurement.

Fresh pool numbers: **needs run at merge**. Historical worker bundle numbers at
the original implementation were 58.0 KB core and 71.8 KB with lazy chunks,
against unchanged 60/73 KB budgets. Those numbers do not measure this follow-up
or establish pool scaling. The earlier daemon throughput failures and browser
long-task failure remain documented in the PR; no performance gate has been
claimed green. Run the repository performance gate and collect pool numbers at
merge. No budget is raised by this change.
