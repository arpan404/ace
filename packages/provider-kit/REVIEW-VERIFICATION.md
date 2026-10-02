# Provider-kit PR 3 review verification

On 2026-10-02, all twelve listed survivor mutations and the additional Codex stderr mutation were applied to the original tests: each affected test run exited 0. After adding behavior tests, each mutation was reapplied and each affected run exited 1. Mutations were then reverted. The signal-policy refactor moved the M5d/M5f mutations into `process-owner.ts`; the behavior remains owner termination and listener cleanup.

| Mutation     | Applied behavior change                         | Regression that fails                                                         | Before / after exit codes |
| ------------ | ----------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------- |
| M5d          | Remove signal re-raise                          | kills owned services when its owner ends via SIGTERM / SIGINT                 | 0 / 1                     |
| M5f          | Never unregister exit listeners                 | repeated ownership releases process exit listeners without warning events     | 0 / 1                     |
| J12          | Ignore stdin error event                        | rejects every pending request and reports EPIPE while the peer is still alive | 0 / 1                     |
| S4           | Do not re-arm heartbeat after gap               | reports recurring heartbeat gaps until the caller aborts                      | 0 / 1                     |
| S7           | Do not reset backoff after delivered event      | resets backoff after a recovered connection delivers an event                 | 0 / 1                     |
| S10          | Remove successful-response content-type check   | rejects a successful HTTP response with the wrong content type                | 0 / 1                     |
| S14          | Carry resume id only after the first connection | keeps the last event id across four connections and clears it on an empty id  | 0 / 1                     |
| D10          | Skip executable permission check                | skips a non-executable file before a valid PATH binary                        | 0 / 1                     |
| D11          | Accept directories as executables               | skips a directory before a valid PATH binary                                  | 0 / 1                     |
| D12          | Choose the last PATH match                      | chooses the first executable PATH match                                       | 0 / 1                     |
| D15          | Remove ANSI stripping                           | parses auth and versions when ANSI sequences interrupt meaningful words       | 0 / 1                     |
| R3           | Remove recorder timeoutMs: null                 | recorder approvals can wait beyond the default RPC deadline                   | 0 / 1                     |
| Codex stderr | Use stdout alone for auth                       | discovers Codex from captured stderr auth output with empty stdout            | 0 / 1                     |

The original stderr gap was reproduced through public discovery by replaying the real captured Codex outputs through a shell executable, preserving empty stdout and stderr status. PATH/override/hang tests now use shell stand-ins and separate cases. Doctor assertions use a changing fake CLI version and logged-in auth in both table and JSON output. Pending RPC exit is checked while a retained grandchild holds stdout open. Signal tests assert native owner exit by the received signal and transcript-flush output, not microtask order or private state. No sleeps synchronize tests.

## Four concurrent offline runs

Four independent `bun run test` invocations ran concurrently, with live mode unset. All exited 0. Each passed 75 tests and skipped four opt-in live tests. Durations: 7.39 s, 6.76 s, 7.71 s, 6.33 s. Default `bun run check` also passes. A preceding repeat exposed a timer assertion counting gaps before the first heartbeat; the guard now counts silence only after that event, and the four-copy run was repeated successfully. The revised guard still rejects S4.

## One opt-in live run

Only version/status probes and initialize/initialized handshakes ran. No sessions, threads or prompts were created. Every started process was stopped. The OpenCode server used an ephemeral port and a fresh password.

```text
$ vitest run packages/provider-kit/src/live.test.ts "--reporter=verbose"

 RUN  v5.0.3 <WORKSPACE>

stdout | packages/provider-kit/src/live.test.ts > installed CLI handshakes (no sessions or prompts)
Live discovery: claude 2.1.286 logged_in; codex 0.159.1 logged_in; opencode 1.18.33 logged_in credentials_configured; cursor 2026.09.26-dd393fe logged_in

 ✓ packages/provider-kit/src/live.test.ts > installed CLI handshakes (no sessions or prompts) > discovers a version and read-only auth status for every installed CLI 1ms
stdout | packages/provider-kit/src/live.test.ts > installed CLI handshakes (no sessions or prompts) > OpenCode global SSE emits connected and heartbeat without creating a session
Live OpenCode: connected + heartbeat; stopped

 ✓ packages/provider-kit/src/live.test.ts > installed CLI handshakes (no sessions or prompts) > OpenCode global SSE emits connected and heartbeat without creating a session 10501ms
stdout | packages/provider-kit/src/live.test.ts > installed CLI handshakes (no sessions or prompts) > Codex app-server initializes over stdio without starting a thread
Live Codex: initialize + initialized; stopped

 ✓ packages/provider-kit/src/live.test.ts > installed CLI handshakes (no sessions or prompts) > Codex app-server initializes over stdio without starting a thread 104ms
stdout | packages/provider-kit/src/live.test.ts > installed CLI handshakes (no sessions or prompts) > Cursor ACP initializes without creating a session
Live Cursor: initialize; stopped

 ✓ packages/provider-kit/src/live.test.ts > installed CLI handshakes (no sessions or prompts) > Cursor ACP initializes without creating a session 383ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  07:46:50
   Duration  11.79s (tests 100%)
```

## Independent-verification follow-up

After merging main, three findings were fixed and the optional grace-period guard was added:

- Retained groups remain owned after natural leader exit and pipe closure. Explicit stop uses a group grace deadline independently of the closed leader, then releases ownership after termination. Owner exit retains its safety net. A descendant with ignored stdio is reachable after the leader's `exited` promise resolves, then unreachable after stop. A separate owner-process test verifies the same closed-pipe descendant dies on owner exit. The stop regression failed against the earlier implementation because the group still existed after its cleanup deadline.
- Owner-exit tests wait for the actual process group to disappear before probing the socket, with a ten-second deadline and event-loop yields. macOS zombie-only EPERM is treated consistently with the supervisor's documented behavior. Socket refusal is retried across transient reset/close races. No sleeps synchronize tests.
- OpenCode zero credentials returns `logged_out` without configured-credential evidence. The corrected public parser assertion failed before this fix and passes afterward.
- The asynchronous TERM-grace test writes a transcript marker after a 100 ms shutdown task and asserts a clean stop plus marker contents. Applying M04, setting the escalation timer to zero, makes this test fail with SIGKILL. Restoring the timer makes it pass. The mutation was reverted.

`bun run check` passes on the merged branch: 152 tests pass across 19 files, with four opt-in live tests skipped. Live tests were not rerun in this follow-up.

Three batches of four independent full `bun run test` invocations ran concurrently. All twelve exited 0, with 152 passed and four skipped in each. No load-related SIGKILL occurred.

| Batch | Copy 1 | Copy 2 | Copy 3 | Copy 4 |
| ----- | ------ | ------ | ------ | ------ |
| 1     | 6.11 s | 7.63 s | 7.30 s | 7.02 s |
| 2     | 6.52 s | 5.52 s | 6.13 s | 7.42 s |
| 3     | 7.46 s | 6.09 s | 7.10 s | 5.38 s |

### Node 24 CI follow-up

The first pushed revision passed Ubuntu CI, but macOS CI exposed the older EPIPE fake peer's stdin-close assumption. Reproducing locally with a temporary, checksum-verified Node 24.21.0 binary failed the EPIPE test at its five-second deadline; the default local Node was 26.8.1. The peer now reads its first request in `/bin/sh`, closes the OS stdin descriptor explicitly, reports that closure, and execs an idle Node process. This keeps a real peer alive without leaving Node's input handle attached to the read endpoint. The same public request/error assertions pass on Node 24. Removing the stdin-error listener still makes them fail, confirming J12 remains caught. No runtime dependencies or system installation changed.

`bun run check` passes on Node 24.21.0. After the EPIPE change, all three four-way full-suite batches were repeated on Node 24 and passed 12/12, again with 152 passed and four live tests skipped in each:

| Batch | Copy 1 | Copy 2 | Copy 3 | Copy 4 |
| ----- | ------ | ------ | ------ | ------ |
| 1     | 5.67 s | 7.12 s | 6.42 s | 7.68 s |
| 2     | 7.47 s | 5.94 s | 6.90 s | 5.18 s |
| 3     | 7.21 s | 5.41 s | 6.45 s | 7.57 s |
