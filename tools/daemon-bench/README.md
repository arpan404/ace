# Daemon turn benchmark

Measures what the daemon spends per agent turn and at idle, end to end, and fails when a
change makes that worse than the checked-in baseline. It sends no model requests and
spends no provider quota.

```sh
bun run bench:daemon                    # one run, compared with baseline.json
bun run bench:daemon --runs=3           # median of three runs (what CI does)
bun run bench:daemon --runs=3 --update-baseline
```

## What a run does

1. Bundles the daemon CLI with `apps/daemon/bench/compile.ts --cli` (or uses `--entry=…/ace.mjs`).
2. Makes a throwaway root (under `/tmp` on macOS, the OS temp folder elsewhere) with a fake
   `HOME`, its own `ACE_HOME`, `ACE_PORT=0` and a `PATH` holding only two programs: the fake
   provider CLI and a link to `git` (the daemon needs git to register a project). Nothing
   from your shell, your `~/.ace` or port 4242 is touched.
3. Starts `ace serve` once to lay out the home, stops it, writes `--seed-threads` finished
   threads (default 400) into its store, and starts it again with the V8 inspector on a free
   port.
4. Connects one client that holds the thread list open, like a sidebar, and watches each
   thread it drives.
5. Waits `--settle-ms` (10 s), then measures:
   - **idle**: `--idle-ms` (60 s) with nothing happening;
   - **newThreads**: `--new-threads` (20) turns, each in a new thread;
   - **sameThread**: `--same-thread-turns` (40) turns sent to one open thread;
   - **longText**: `--long-text-turns` (3) new threads whose answer streams
     `--long-text-deltas` (1,000) extra text deltas, about 90 KB, one every `--delta-ms` (10).

   One warm-up turn before the phases absorbs one-time provider discovery.

Results are JSON on stdout (and `--output=FILE`); `bench:daemon` keeps each run in
`.ace-dev/daemon-bench/run-N.json`. `--keep` leaves the throwaway root, daemon logs
included, for inspection.

## The fake provider CLI

`src/fake-cli` is a stand-in for the `claude` executable. It answers `--version` and
`auth status`, acknowledges every control request (with a small model menu for
`initialize`), and for each user message replays a recording from
`fixtures/claude/2.1.286` at `ACE_FAKE_CLI_SPEED` (recorded gaps divided by 20). Each
replay gets fresh uuids, per-turn tool and message ids, the session id the daemon asked
for, and a result that echoes the sent message's uuid with an increasing `result_index`.
Text in the user message picks the scenario: `fixture=subagent` replays another
recording, `text-deltas=N` stretches the final answer. Another provider would add its own
protocol file beside `claude.ts`.

## What each number means

| Metric                         | Meaning                                                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calibrationMs`                | On-thread CPU for a fixed JSON/Map/allocation loop run inside the daemon through the inspector, fastest of 14 runs. A machine-speed yardstick measured in the same process and runtime. |
| `phases.*.cpuMsPerTurn`        | Daemon CPU (all threads, from `process.cpuUsage`) per turn, in ms. Not gated: it depends on the machine.                                                                                |
| `phases.*.cpuPerTurn`          | `cpuMsPerTurn / calibrationMs`. Gated; comparable across machines.                                                                                                                      |
| `idle.cpuPercent`              | Idle daemon CPU as a percentage of one core. Informational.                                                                                                                             |
| `idle.cpuPerMinute`            | Idle CPU per minute divided by `calibrationMs`. Gated.                                                                                                                                  |
| `phases.*.transactionsPerTurn` | SQLite write transactions per turn, from daemon health counters. Deterministic, so gated tightly.                                                                                       |
| `*.heapUsed`                   | Main-isolate heap after two forced full GCs.                                                                                                                                            |
| `*.rss`                        | Resident set size at the same moment.                                                                                                                                                   |
| `*.footprint`                  | macOS physical footprint (`footprint -p`), what Activity Monitor shows.                                                                                                                 |
| `wallMs`                       | Phase duration. Informational: it is mostly the fake's replay pacing.                                                                                                                   |

Provider CLI processes are separate and not counted; only the daemon process is measured.

## The gate

`baseline.json` holds one entry per `platform-arch` with each metric's median, and one list
of tolerances. A metric fails when it grows by more than `relative` of its baseline and by
more than `absolute` in its own unit. Drops beyond tolerance pass and print a hint to update
the baseline. Metrics marked `portable` (normalized CPU and transactions) compare against
another platform's baseline when this one has none; the others are reported as `new`.

Why the tolerances in `baseline.json` are what they are, from twelve full runs on a
loaded M-series Mac (load average 30–125) in four sets of three:

- **Transactions per turn**, 10% (+3): new-thread and same-thread turns varied by under 1%
  (≈139 and ≈100). Long-text turns, 20%: buffered deltas share 75 ms flushes, so they
  varied by about 11% (≈2,100 for 1,000 deltas).
- **Normalized CPU per turn**, 35%: single runs varied by up to 2× under load, but medians
  of three stayed within about 20% of each other while the calibration itself moved by
  30%. Gate on `--runs=3`; one run is a smoke test, not a verdict.
- **Idle CPU per minute**, 50% (+2): small and noisy (about 1% of one core).
- **Heap after GC**, 10% (+4 MiB): varied by under 0.5%; a leak of a few MiB fails.
- **RSS and footprint**, 15% (+16 MiB): varied by up to 10% (allocator and page reuse).

Heap, RSS and footprint are only compared on the platform that measured them.

## Updating the baseline

Update it in the same change that intentionally moves a number, and say why in the commit:

```sh
bun run bench:daemon --runs=3 --update-baseline
```

That rewrites only your platform's entry. For the Linux entry, download the `daemon-bench`
artifact from a CI run and adopt it from any machine; saved results carry their platform:

```sh
bun run bench:daemon --results=run-1.json,run-2.json,run-3.json --update-baseline
```

## CI

The `daemon-bench` job in `.github/workflows/check.yml` runs three times on Linux with Node 24
and uploads the results. It is `continue-on-error` until it has proven stable on shared
runners; remove that line to make it blocking.
