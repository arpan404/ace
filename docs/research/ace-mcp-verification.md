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
- A browser adapter receives typed input, caller attribution and cancellation.
- Notification notice and intent persist atomically, survive restart and acknowledge once.
- Failed event persistence rolls back the notice and the pending intent.
- Spawn accepts an intent without claiming an agent started or finished.
- Agent pages preserve late parent links and canonical waiting/human status.
- Older SQLite databases backfill the agent index and retain live incremental updates.

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

All thirteen mutations were killed. The final baseline passes `bun run check` on
Node 24.21.0 and Node 26.8.1. Live-provider suites remain opt-in and skipped.

## Non-gating performance

These are single-process measurements on this shared development machine,
without a performance assertion or a wall-clock test budget.

| Benchmark                                 | Operations/s | Microseconds/op | Peak RSS MiB |
| ----------------------------------------- | -----------: | --------------: | -----------: |
| Credential digest lookup                  |    1,816,337 |            0.55 |        156.3 |
| Validated dispatch                        |      158,483 |            6.31 |        228.0 |
| Real current-spec HTTP round trip         |          299 |        3,343.33 |        289.6 |
| Persisted agent status and index          |       28,842 |           34.67 |        132.0 |
| Indexed page of 50 agents                 |       15,500 |           64.52 |        183.6 |
| Atomic notice/intent plus acknowledgement |       15,896 |           62.91 |        185.6 |

Measured with Node 26.8.1. RSS is the process high-water mark, including Node,
SDK initialization, GC heap capacity and preceding benchmark stages. It is
not a per-operation retained allocation. Scripts live in `packages/mcp-server/bench`
and `apps/daemon/bench`. The final dispatch measurements include the budget check
before schema cloning and serialization. Tool schema conversion happens at registration; transport
instances have no replay buffer. SQLite agent indexing performs work only for
agent changes and reads through the thread/id index.

## Integration boundaries

Provider adapters must apply the helpers and bind lease lifetime to provider
session ownership. Notification and orchestration workers consume the persisted
outbox and deduplicate by id before acknowledgement. Browser/preview owners
register their own schemas and adapters. Discovery APIs are injected read-only
ports; ACP has no standard server-enumeration RPC. Environment-specific and
ancestor config paths are supplied by provider adapters. The endpoint remains
on its own loopback listener and is never mounted in remote/relay routers.
