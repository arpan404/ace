# Diagnostics verification

## Current validation policy

The repo owner stopped the continuation and deferred all tests, mutation runs, probes and benchmarks to merge time. The delivered head has static review only. Runtime behavior, mutation outcomes and final performance numbers need run at merge. No provider prompts or recorder sessions were used. GitHub CI was neither run nor awaited.

Allowed static checks pass after merging main through `50c725f`: `bun run fmt`, `bun run lint`, `bun run typecheck` and `bun run check:size`. Newly merged workspaces required local dependency links for static resolution. No production logic was executed to validate the final merge.

## Written behavior coverage

Each item below describes assertions in public API tests, not an execution claim. All need run at merge.

- Durable JSONL and recent logs omit known token formats, case-insensitive authorization, home paths and environment values.
- Embedded SQLite JSON payloads strip array-valued refresh tokens and object-valued passwords; ordinary arrays survive.
- Scrubbed key collisions, deeply nested JSON and damaged structured records cannot select a weaker redaction fallback.
- Child loggers share level filtering, queue capacity and failed-write/drop counters.
- A blocked sink counts its outstanding batch inside capacity; overflow drops without waiting for disk.
- Rotation preserves complete recent records and obeys per-file and total byte limits across restart.
- Arbitrary producer objects are never enumerated; array and Error accessors are replaced without invoking getters.
- Explicit fields obey visited-value, depth, key-size and total character limits before copying.
- Every unhealthy doctor verdict has a specific explanation and fix hint, including low disk.
- Hung doctor checks abort on injected deadlines while independent checks complete.
- PTY resolution follows the daemon installation even when an unrelated cwd supplies another module.
- Missing first-run storage uses a writable/searchable ancestor without creating directories or requiring listing permission.
- Provider discovery uses version and login-status commands only; Antigravity reports installed version and unknown login.
- Real read-only integrity checks distinguish intact and deliberately corrupted SQLite files without changing them.
- SQLite cancellation after a native-work stdout barrier stops the real child and preserves database bytes.
- Health records a nonzero active-resource count while a real loopback listener is open.
- Injected memory, workload and delay measurements reach health; delay values convert to milliseconds and reset per interval.
- An injected health deadline aborts an in-flight SQLite measurement and returns unavailable sizes.
- A stalled real log worker is terminated by an injected deadline.
- Authenticated read-scope health requests avoid receipts/events, coalesce measurement and bound pending requests per socket.
- Daemon socket input and pending health queues use incremental counters.
- Archives contain redacted report, versions, settings and recent logs; threads require explicit opt-in.
- Rotation deletion between listing and opening is skipped, and opened descriptors bound file reads.
- Input byte budgets stop newline-free sources and close the source; abort removes private staging files.
- Unicode secrets remain redacted across internal chunk boundaries; oversized lines are omitted whole.
- SQLite byte metadata limits both payload and event-type columns before worker transfer.
- Symlinked logs and arbitrary credential files are excluded; success and failure remove staging files.
- CLI doctor creates no daemon state; support export refuses to replace existing output.

## Mutation cases for the delivered head

These cases are designed to exercise the revised public behavior tests. The status of each on the final merged head is **not executed (tests run at merge)**. Earlier runs preceded the owner's new rule and do not validate the final integration.

| Mutation                                   | Behavioral assertion                                            | Current status                    |
| ------------------------------------------ | --------------------------------------------------------------- | --------------------------------- |
| Review #17: omit normal arrays             | Exact array contents in recent and persisted JSONL              | not executed (tests run at merge) |
| Review #19: return zero handles            | Active-resource count is positive with a real listener          | not executed (tests run at merge) |
| Review #20: erase low-disk explanation     | Low-disk message and fix contain actionable facts               | not executed (tests run at merge) |
| Match authorization case-sensitively       | Lowercase opaque bearer token absent from durable file          | not executed (tests run at merge) |
| Skip structural redaction of embedded JSON | Array/object secrets absent from archive                        | not executed (tests run at merge) |
| Disable recursion cap                      | Excessive nesting yields a safe omission without leaking        | not executed (tests run at merge) |
| Reject disappeared rotated files           | Export still produces a readable archive                        | not executed (tests run at merge) |
| Resolve PTY relative to cwd                | Unrelated compatible module cannot mask invalid installed addon | not executed (tests run at merge) |
| Reject missing data directory              | Writable ancestor produces usable first-run disk facts          | not executed (tests run at merge) |
| Disable export input cap                   | Newline-free source consumption stays within its budget         | not executed (tests run at merge) |
| Invoke array accessors                     | Public output contains omission marker and no getter result     | not executed (tests run at merge) |
| Transfer oversized type column             | Exported line contains bounded type omission marker             | not executed (tests run at merge) |

Existing tests also cover API-key/env scrubbing, level filtering, overflow, failed-write counts, rotation, retention, Node minimum, timeout severity, integrity verdict, thread opt-in, payload bytes, histogram conversion/reset, recent-history selection, archive cap, provider discovery, health coalescing, read authorization and pending-request bounds.

## Performance design and historical measurements

Producer work has fixed caps: 64 visited values, depth four, 32 fields per container, 128 characters per key, 2,048 per string and 4,096 total key/value characters. Unprepared objects become a fixed marker. Queues and rings have fixed capacity; only one worker batch is outstanding. Bundle reads and writes have separate byte budgets; sanitized output is batched and streamed. Thread SQL checks byte lengths before transfer. Email matching prevents repeated scans starting inside an alphanumeric run.

Non-gating benchmarks are `bench/logger.ts`, `bench/producer.ts` and `bench/bundle.ts` in this package. They cover durable logging, huge-object producer handling and streamed redaction/export. Do not execute them before merge under the owner's rule.

Historical follow-up measurements, taken before the no-execution rule and before the final integrated head, were 504,807 enqueues/s, 2,820 persisted records/s, 1.981 microseconds/enqueue and 177.89 MiB peak RSS with zero drops; streamed bundle redaction reached 2.794 MiB/s with 120.42 MiB peak RSS for 14.694 MiB input. The shared host was heavily loaded. These numbers are historical observations, not performance validation of this head. Final throughput and peak RSS need run at merge.

## Limits

Antigravity's documented CLI has interactive sign-in but no established read-only login-status command, so doctor reports unknown login with a verification hint. Main now includes orchestrator contracts but the daemon still has no live provider-session registry. `startDaemon` accepts workload counters as its sixth argument; sessions default to null while daemon queues are measured. Support logs are a best-effort descriptor snapshot rather than an atomic snapshot. Active handles count Node active resources rather than every OS file descriptor.

## Independent-verifier follow-up

The verifier of `44d9017` identified an extra JSON-string encoding that still reached lexical redaction. Quoted wrappers now enter the existing bounded recursive parser. Written public tests cover repeated wrappers with preserved normal arrays and extracted raw-log tar contents containing wrappers, colliding keys and deep records.

Archive tests now parse the result after deterministic disappearance and during concurrent real-worker rotation. PTY coverage has valid and invalid installation paths independent of cwd. A proxy that throws during prototype inspection must produce a normalization marker, and the next record must still persist. First-run storage tests inject 2 GiB capacity while preserving real statfs path checks and permissions, so they do not depend on host free space.

Provider-kit now forwards the probe byte cap to raw supervision before readline, and reports an output-limit exit as a failed probe. Its new newline-free real-child test also checks the exit reason. Probe schedulers and discovery subprocess boundaries are injected; direct SQLite/PTY/discovery edge tests disable production deadlines in favor of the suite watchdog. The native SQLite barrier races child completion/failure, so a startup failure rejects rather than waiting indefinitely for a missing signal. Deadline behavior still has explicit injected-clock coverage.

A public daemon socket test reads changing session/queue measurements from the engine workload port and verifies daemon-owned counters cannot be overwritten, with no event-log writes. No live provider registry exists in the merged daemon. Antigravity login is still unknown because its safe version command does not establish authentication. These remain disclosed integration limits, not fabricated measurements or prompts.

| Additional mutation case                           | Behavioral assertion                                                           | Current status                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------- |
| Bypass quoted JSON wrappers                        | Wrapped opaque token absent from redactor output and extracted raw logs        | not executed (tests run at merge) |
| Return false for every PTY probe                   | Valid installed module returns true despite broken cwd module                  | not executed (tests run at merge) |
| Remove normalization catch                         | Throwing prototype proxy emits marker; subsequent record persists              | not executed (tests run at merge) |
| Remove raw probe byte cap                          | Newline-free child rejects for output limit and exits with output-limit reason | not executed (tests run at merge) |
| Emit an invalid archive after rotation             | Extracted metadata and JSONL remain readable during real-worker rotation       | not executed (tests run at merge) |
| Cache workload rather than sample current counters | Two authenticated health responses reflect changed sessions/queues             | not executed (tests run at merge) |

No tests, mutations, flakiness runs, probes, benchmarks, full check or CI were executed in this follow-up. All behavior and final performance conclusions **need run at merge**. Historical numbers above remain historical; quoted-wrapper work is capped by the existing maximum record length, 32 levels and 10,000 visited values. Raw probe capture stops after the byte budget with at most one transport chunk in flight. Newline-free output has no unbounded line accumulation.
