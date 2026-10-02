# Diagnostics

`@ace/diagnostics` owns backend diagnostics. It never starts a provider session.

```sh
bun run ace doctor
bun run ace doctor --json
bun run ace support-bundle ./ace-support.tar.gz
bun run ace support-bundle ./ace-support.tar.gz --include-threads
node packages/diagnostics/bench/logger.ts
```

`ACE_HOME` selects the data directory, `ACE_PORT` selects the loopback port and `ACE_CHROMIUM` can select a browser executable. Doctor checks run concurrently with a five-second deadline each. Any failure sets exit code 1. Warnings include optional missing CLIs, unavailable browser discovery and a port occupied by an existing daemon. Antigravity/ACP discovery currently warns because provider-kit does not implement it. Doctor never creates or repairs a database. Remote configurations also check OpenSSL for TLS.

The daemon writes owner-only JSONL under `$ACE_HOME/logs`. Default limits are 1 MiB per file, 8 MiB total, 1,024 queued records including the outstanding batch, batches of 128, and 256 recent records in memory. A record has at most 64 visited values, four nesting levels and 2,048 characters per string. Larger strings are omitted whole. Disk failures increment a counter and do not stop agent processing. Closing the logger drains accepted records; a worker that does not acknowledge within five seconds is stopped.

`createLogger` takes an injected clock, batch sink, redactor and optional scheduler. Children share levels, retention and drop counters. `createFileSink` starts a worker that redacts before writing. Use the same redaction context for the ring and sink. `@ace/redaction` owns secret-format and secret-key rules shared with the recorder.

`createDoctorChecks` takes `DoctorProbes`; pure verdict functions interpret the facts. `runDoctor` owns deadlines and cancellation. `createSystemProbes` uses provider-kit's version and login-status probes. SQLite integrity runs read-only in a killable child process.

Authenticated clients with read scope send the existing command envelope with `payload: { type: "diagnostics.health" }`. Successful `commandResult` messages have `health` containing process memory, event-loop lag, active resource count, SQLite page/WAL bytes, sessions, queues and logger counters. Unknown metrics are null. The current daemon has no engine session registry, so `startDaemon` accepts a third argument supplying session and queue counters; sessions default to null. Only one sample runs at a time, with one pending request allowed per socket. Health commands do not write receipts or events.

Support archives include `doctor.json`, `versions.json`, `settings.json` and recent JSONL logs. Secret settings keys, known token formats, home paths and environment values are redacted before temporary or final writes. Conversation events are excluded by default. Opt-in thread exports contain at most 2,000 recent events, omit events over 60,000 bytes and never include the database or WAL itself. Total uncompressed content is capped at 16 MiB. Lines over 64 Ki characters are omitted whole. The archive is streamed, refuses to overwrite existing output, and deletes staging files after success or failure. Exported conversations may contain sensitive prose that no format-based redactor can recognize; review an opt-in archive before sharing it.

Short non-secret environment values such as `1` are scrubbed when they are a whole string, preserving version numbers. Secret-bearing environment variables are scrubbed even when short. Thread export pulls batches of at most 16 bounded events, with one batch outstanding.
