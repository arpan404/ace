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
