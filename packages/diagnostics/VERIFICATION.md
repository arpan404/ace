# Diagnostics verification

Local runtime: macOS, Node v26.8.1, Bun v1.4.0. Provider prompts and recorder sessions were never run. Fake CLI fixtures accept only version and authentication-status requests.

## Behavioral checks

- Known provider, GitHub, AWS, Google, Slack, npm, Stripe, JWT and authorization tokens never reach the JSONL file or exported recent ring.
- Home paths and opaque environment values are removed; structured secret keys are stripped even for arrays and numeric values.
- JSON stays parseable when short environment values overlap version numbers or timestamps.
- Child loggers share level filtering, queue capacity and failure/drop counters.
- A blocked sink retains its outstanding batch inside capacity; a full queue drops synchronously without waiting for it.
- Rotation preserves complete recent records and enforces both per-file and total byte caps after restart.
- Circular data and getters cannot throw from ordinary log calls.
- Every doctor machine/provider probe has healthy and unhealthy outcomes with fix hints.
- A hung doctor probe hits its injected deadline, aborts and does not gate healthy checks.
- Real read-only SQLite integrity checks accept valid data and reject a deliberately overwritten SQLite header without repairing it.
- Loop delay is converted from nanoseconds to milliseconds and reset between measured intervals.
- An unavailable log directory leaves daemon operations available and increments health failure counters.
- Health includes real page/WAL sizes, memory, workload counters and logger failures; simultaneous collection shares one sample.
- Authenticated retries get current health without events or receipts; one pending request per socket bounds waiting responses.
- A paired device with read scope can request health without operate permission.
- Support archives contain the report, versions, settings and recent logs, excluding conversation content by default.
- Explicit thread export redacts secrets crossing chunk boundaries, omits oversized lines and respects the archive byte cap.
- Thread reads cap history at 2,000 events, pull one batch of 16 at a time and reject oversized ASCII and multibyte payloads before transfer.
- Symlinked logs and arbitrary credential files are excluded; staging files are removed after success and source failure.
- Doctor creates no writable daemon state. The support CLI creates a gzip archive and refuses to replace existing output.
- An aborted provider-kit probe stops its real child without waiting for output.

## Mutation checks

Each mutation was applied to production code alone, made its named public behavioral test fail, and was restored byte-for-byte before the next mutation. Vitest used one worker. Every run exited 1 with a test failure, not a parser failure.

| Mutation                                | Test that failed                                      |
| --------------------------------------- | ----------------------------------------------------- |
| Remove API-key format redaction         | no known token reaches file or ring                   |
| Skip environment-value redaction        | no known token reaches file or ring                   |
| Reverse child logger level filtering    | child loggers share filtering and failed-write counts |
| Accept an entry beyond full capacity    | full queue drops while the sink owns a batch          |
| Stop counting failed disk batches       | failed writes do not escape and are counted           |
| Rotate only after twice the file cap    | size rotation and total retention across restart      |
| Retain one hundred times the total cap  | size rotation and total retention across restart      |
| Accept unsupported Node 23              | unhealthy Node probe explains failure                 |
| Treat a hung probe as only a warning    | hung probe times out and aborts                       |
| Report a corrupt SQLite file as healthy | deliberately corrupted SQLite reports corruption      |
| Export threads without explicit opt-in  | archive excludes threads by default                   |

## Non-gating benchmark

Command: `node packages/diagnostics/bench/logger.ts`. The benchmark enqueues and persists 100,000 representative records through the real redacting file worker in batches, while rotating and enforcing retention. It reports parent-process peak RSS, which includes the worker thread.

Most recent run on the shared machine:

- Enqueue: 3,190,187 entries/sec, 0.313 microseconds per entry.
- Persisted: 28,353 entries/sec.
- Peak RSS: 163.61 MiB.
- Drops and failed writes: zero.

The machine was running other workstreams, so throughput varies with load. Earlier runs reached 63,844 persisted entries/sec. No throughput or elapsed-time assertion gates tests.

## Local gate

`VITEST_MAX_WORKERS=1 bun run check` passes format, lint, source size, all package typechecks and the full test suite. The worker cap avoids oversubscribing this shared machine. This feature changes no test assertions or harness deadlines to obtain a pass. The latest imported main commit includes its own remote CLI harness deadline adjustment. The final suite has 441 passing tests and four skipped tests. Existing opt-in live-provider tests remain skipped, and GitHub CI was neither run nor awaited.
