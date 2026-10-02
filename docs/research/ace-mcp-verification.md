# ace MCP verification

Checked 2026-10-02 on macOS arm64. Provider CLIs were never prompted and the
recorder was never run. Integration tests use synthetic clients and loopback
HTTP. Discovery tests use temporary configs and a synthetic OpenCode HTTP API.

## Protocol and behavior

- The official v2 client discovers and calls the 2026-07-28 endpoint.
- The official monolithic v1 client initializes and calls the same endpoint.
- Capability-filtered discovery and direct-call denial prevent backend effects.
- Session exit rejects later POST, GET and DELETE requests.
- Session revocation aborts ongoing execution and suppresses late success.
- Current HTTP cancellation and legacy cancellation notifications reach tool I/O.
- Injected timers abort timed-out calls without a wall-clock assertion.
- Independent calls finish while another backend is waiting at an explicit barrier.
- Concurrent notification/spawn calls retain the credential's own node attribution.
- Input and output validation reject malformed values; backend errors stay private.
- Oversized, cyclic and deeply nested results fail before schema cloning or serialization.
- Credential capacity rejects new leases, and shutdown permanently closes authority.
- Uncooperative timed-out backends retain their slots until execution ends.
- Host/Origin checks and body bounds reject hostile or oversized HTTP requests.
- Each provider helper emits its documented configuration, with secrets outside Codex argv.
- Discovery returns redacted metadata without changing config bytes.
- Codex API paging is bounded, Claude SDK status reads cancel, and OpenCode GET /mcp uses the directory.
- A browser adapter receives typed input, caller attribution and cancellation; unauthorized calls have no effects.
- Notification notice and intent persist atomically, survive restart and acknowledge once.
- Failed event persistence rolls back the notice and the pending intent.
- Spawn accepts an intent without claiming an agent started or finished.
- Agent pages preserve late parent links and canonical waiting/human status.
- Older SQLite databases backfill the agent index and retain live incremental updates.
- Repeated agent creation replaces the indexed agent both during append and database upgrade.
- FIFO configs are rejected without a writer, and cancellation settles without blocking filesystem workers.
- Missing or mismatched mirrored custom headers return HTTP 400 / JSON-RPC `-32020` before effects.
- Mirrored parameters support plain ASCII, Unicode, whitespace, newlines and literal Base64 sentinels.
- Claude project opt-outs disable config and API entries without modifying files.
- Tool registration, active-tool and HTTP admission reject excess work and preserve later availability.
- Foreign-thread read ports cannot expose thread or agent data.

## Review regression evidence

Before changing production code, ran:

```sh
bun run test apps/daemon/src/mcp-upgrade.test.ts packages/mcp-server/src/discovery-fifo.test.ts packages/mcp-server/src/http-boundaries.test.ts
```

Both database tests failed with `Cannot redefine property: root`. Both real-FIFO
tests failed at Vitest's deadlock timeout; neither test asserts a wall-clock
budget or uses a synchronization sleep. The custom-header test observed HTTP
200 instead of 400. After the fixes, all five passed. The full feature suite
now passes 50 tests. The raw Host test uses Node HTTP with a valid tool call,
asserts HTTP 403 and no effects, and then verifies an allowed call succeeds.
The independent-call barrier test now uses an injected scheduler.

## Mutation checks

Each change was applied to production code individually. The named behavior
failed under Vitest, then the original code was restored. No mutation remains.

| Mutation                                        | Behavior that failed                                              |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| Return true from capability check               | Filters unauthorized tools and rejects direct capability bypasses |
| Keep credential digest on revocation            | Rejects every later HTTP method after session end                 |
| Substitute a wrong agent in tool context        | Attributes concurrent builtin intents to the correct nodes        |
| Skip input parsing                              | Validates both tool boundaries before effects                     |
| Skip output parsing                             | Rejects invalid tool output                                       |
| Classify timeout as cancellation                | Reports timeout while aborting backend work                       |
| Skip Origin validation                          | Rejects hostile origins                                           |
| Inject OpenCode type `http` instead of `remote` | Produces the exact OpenCode config shape                          |
| Stop indexing status/update events              | Preserves late parent linkage and canonical status in pages       |
| Enqueue intent outside the event transaction    | Rolls back intent and notice when persistence fails               |
| Omit Claude HTTP bearer headers                 | Produces the exact Agent SDK shape                                |
| Release capacity as soon as timeout returns     | Retains capacity while a backend ignores cancellation             |
| Skip budget before output parsing               | Rejects cyclic/deep results before schema cloning                 |

All thirteen initial-delivery mutations were killed. The review follow-up
applied and killed these eleven additional production mutations individually:

| Mutation                                         | Behavior that failed                                             |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| Remove Host guard (review survivor)              | Raw hostile Host is rejected before effects                      |
| Remove tool registration limit (review survivor) | Excess tool registration fails; admitted tool still works        |
| Remove HTTP admission limit (review survivor)    | Excess HTTP work returns 503 without effects; recovery succeeds  |
| Remove agent thread guard (review survivor)      | Foreign-thread agents are not exposed                            |
| Remove thread guard (review survivor)            | Foreign-thread metadata is not exposed                           |
| Make seeded agent property nonconfigurable       | Repeated creation append and legacy database upgrade succeed     |
| Remove nonblocking config open                   | Real FIFO rejection and cancellation settle without a writer     |
| Return low-level Server instead of McpServer     | Custom-header mismatch fails before effects                      |
| Ignore Claude project opt-outs                   | Disabled config/API entries remain disabled without file changes |
| Remove active-tool admission limit               | Excess execution is rejected before effects; recovery succeeds   |
| Omit prepared input-schema lookup                | Custom-header validation rejects missing/mismatched values       |

No mutation remains. The final baseline passes `bun run check` on Node
24.21.0: 450 passed, four opt-in live-provider tests skipped. Format, lint,
workspace typechecks and the 1,500-line size check pass.

## Main integration and verifier N3

Merged remote-access main `844e0eb`, then shared CLI fixture fixes from
`51e739a`, without rebasing. Both benchmark scripts,
MCP and remote dependencies, protocol exports, Store projections and daemon
listeners are retained. Shutdown closes MCP and local/remote listeners, closes
the Store, removes the endpoint file and releases the lock. The startup error
path closes both owned servers before releasing the Store and lock.

A real LAN/TLS daemon test pairs an admin device, reads remote status, calls the
local MCP endpoint with an agent lease, rejects a device token at MCP, and
verifies the remote listener does not expose `/mcp`. Restart preserves devices,
the TLS identity and the MCP agent index while invalidating the old agent lease.
Device scopes (`read`, `operate`, `admin`) authorize companion clients; MCP
capabilities authorize provider-session tools and carry thread/agent attribution.
They remain separate authority models, with no device-to-tool implicit grant.

The CLI loads the daemon only for `start`, so short admin commands do not load
the MCP SDK. A non-gating stopped-status probe on the shared machine measured
1.23s before and 0.41s after this change; these are observations, not assertions.
Full-suite attempts encountered runner timeouts under contention; an isolated
instrumented CLI sequence finished in 1.09s. Instrumentation was removed, and
an unchanged-deadline full Node 24 check passed all 450 tests afterward.

Verifier mutation N3 removed the opened-descriptor regular-file check. Added a
public discovery test using `/dev/null` plus a valid regular config as a control.
The original passes, removal fails because discovery reports `invalid` instead
of rejecting the device as `unreadable`, and restoration passes. The mutation
is reverted. No timing assertions or test-runner overrides were added. The
subsequent main fixture fix preserves its upstream 15-second CLI integration
deadlock timeout. CI is disabled by the repository owner and was not run or
queried in this integration round.

## Non-gating performance

These are single-process measurements on this shared development machine,
without a performance assertion or a wall-clock test budget.

| Benchmark                                 | Operations/s | Microseconds/op | Peak RSS MiB |
| ----------------------------------------- | -----------: | --------------: | -----------: |
| Credential digest lookup                  |    1,112,490 |            0.90 |        172.8 |
| Validated dispatch                        |      226,231 |            4.42 |        245.0 |
| Prepared input-schema lookup              |   68,388,717 |            0.01 |        245.0 |
| Real current-spec HTTP round trip         |        1,856 |          538.74 |        382.5 |
| Real current-spec HTTP with custom header |        2,124 |          470.88 |        428.5 |
| Persisted agent status and index          |       14,910 |           67.07 |        155.1 |
| Indexed page of 50 agents                 |       13,747 |           72.74 |        190.4 |
| Atomic notice/intent plus acknowledgement |       13,833 |           72.29 |        192.3 |

Measured with Node 24.21.0 on macOS arm64. HTTP paths receive 200 warmup calls
each before measurement. Run-to-run scheduling and JIT/GC effects mean these
figures do not establish that custom-header calls are faster. RSS is the
process high-water mark, including Node, SDK initialization, GC heap capacity
and preceding benchmark stages; it is not per-operation retained allocation.
Scripts live in `packages/mcp-server/bench` and `apps/daemon/bench`.
Dispatch includes budgets before schema cloning and serialization. Schemas
are converted at registration and fetched by tool name in O(1); the SDK
validates only the requested tool's schema. There is no history scan, toolkit
registration loop, replay buffer or added per-request cache. SQLite indexing
updates only changed agents and reads through the thread/id index.

## Integration boundaries

Provider adapters must apply the helpers and bind lease lifetime to provider
session ownership. Notification and orchestration workers consume the persisted
outbox and deduplicate by id before acknowledgement. Browser/preview owners
register their own schemas and adapters. Discovery APIs are injected read-only
ports; ACP has no standard server-enumeration RPC. Environment-specific and
ancestor config paths are supplied by provider adapters. The endpoint remains
on its own loopback listener and is never mounted in remote/relay routers.
