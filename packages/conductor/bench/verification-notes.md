# Verifier follow-up validation

The two verifier blockers were reproduced through public Conductor APIs before changing production code. Unicode final-sigma and long-s aliases admitted independent workers; buffered repeated done shifted the deadline from 1,100 to 2,000. Their regression tests now pass. Real inode checks and composed/decomposed Unicode admission guard the NFC mutation.

The deadline fix separately retains its first done timestamp and latest activity timestamp. Tests cover both sides of acknowledgement, missing-artifact escalation before acknowledgement, cold SQLite restore, late artifacts behind the gate, stalled acknowledgement with an artifact already present, and stale working facts. Twenty-two production mutations fail assertions and are restored byte-for-byte.

N15 is a performance mutation rather than a failure at the production baseline. `reparse-probe.py` measures normal persistence and temporarily inserts full-state parsing in every apply, restoring production in `finally`. At 256 workstreams with 128 paths each, 50 diagnostic updates measured 129.16 µs normally and 99,536.33 µs with the mutation. Complete throughput and RSS measurements are in `reparse-results.json`. There is no wall-clock timing assertion in the test gate.

A broad local run exposed the existing daemon lifecycle test's five-second timeout. The test and CLI/index sources have no diff against the pinned main revision `9f2a382`. On detached `origin/main` at `9f2a382`, the complete lifecycle file passed all five tests without added load. Under an identical bounded load on main and Conductor, the test named “prevents a second process sharing the database and restarts after SIGTERM” failed with `Test timed out in 5000ms` in both. Both executions reported 5,048 ms for that test. The diagnostic ran 96 CPU-bound Node workers, signalled readiness through messages, capped their lifetime at 30 seconds, and terminated/reaped them after each test. No synchronization sleeps or provider processes were used. The test was left unchanged.

A main-only run with TMPDIR inside this repository also exposed Git fixture assumptions: a scratch directory inside a checkout is a repository, and CommonJS stand-ins inherit the checkout's ESM scope. Final full validation uses the normal OS temp directory, which provides the intended non-repository fixture environment. All source edits remain in this worktree.

CI is disabled by the repository owner. No CI run, rerun, check watch or CI wait was requested in this follow-up. Local `bun run check` is the gate.
