# @ace/adapter-acp

ACP v1 translation and supervised sessions, with Cursor and experimental Antigravity quirks. Written from ace's provider research, recorded frames, and the primary ACP schema. No ACP SDK validates vendor methods.

## API

```ts
import { cursorAdapter, antigravityAdapter, createAcpAdapter } from "@ace/adapter-acp";

const translator = cursorAdapter.createTranslator({ threadId, rootKey: "root" });
const facts = translator.translate(frame, frame.t);
const session = await cursorAdapter.openSession(context);
await session.send([{ type: "text", text: "User input" }], "queue");
```

`cursorAdapter` and `antigravityAdapter` implement ADR 0007's `ProviderAdapter`. `createAcpAdapter` accepts optional quirks and a user-installed command, arguments, and environment overrides. Generic ACP requires an explicit command. Cursor resolves `agent` through provider-kit discovery and launches `agent acp`. Antigravity resolves `agy_acp_server` through provider-kit's executable discovery. ace supplies no CLI, credentials, authentication flow, filesystem-write capability, or terminal capability.

`createAcpTranslator` takes `{ threadId, rootKey, identity }` plus an optional quirk module. `createTranslatorIdentity(generation, cursor)` supplies its injected allocator state. The caller can persist generation and cursor together; a fresh translator lifetime must use a fresh generation or continue the saved cursor. `createAcpAdapter` accepts an `identity()` factory for deterministic replay or persisted allocation; its I/O factory defaults to a fresh UUID per translator. Child association keys remain stable across generations. `openAcpSession` is the low-level process boundary for an already resolved executable. Its optional runtime injects the process spawner, monotonic clock and cancellable timer scheduler. `nativeAgentKey(threadId, sessionId)` supplies the child keys accepted by `interrupt`; omitted targets or `root` address the root. Interaction keys are `request:<id type>:<rpc id>` and match the translator's facts.

Sessions forward sent and received JSON-RPC frames, malformed lines, stderr, queue changes and lifecycle notes through `SessionContext`. `onExit` also reports the owned process exit. Core ignores duplicate lifecycle facts. Close stops the process group through provider-kit and expires pending requests through process lifecycle facts.

## Translation and control

- Root prompts bracket user runs. Child traffic synthesizes spawn runs. Unknown child traffic creates a provisional child, and later associations repair its parent and spawning-tool link.
- Cursor's `subagent_spawned` and `subagent_state_update` coexist with draft `subagent_update`. Omitted or null draft state never proves completion. Child keys preserve opaque IDs, including newlines and invalid Unicode, without using them as filesystem paths.
- Tools are reclassified on refresh. Tool IDs are scoped to their session. Native names, input, output and unknown fields remain in raw payloads. Nonzero exit codes, errors and permission denial override `completed`; plan and permission rejections remain declined.
- Cursor background children have tracked tasks. The parent's held prompt is split when it waits for a background result, then resumes with `subagent_result`. Core's current precedence counts a working child as a working thread, even while the root is blocked on that task.
- A cancelled shell with no terminal update becomes a cancelled tool plus an unknown shell task. A child without a cancellation update gets a 12-second translator grace deadline, exposed to the engine through `wake.expected`, then an interrupted run and a synthetic raw note. Late live traffic reopens that child. Child background tasks become unknown. Uncertain shell execution holds completion until a later terminal update confirms its outcome. The translator retains its native tool/task identity across process restart, scoped to the native session, so resumed evidence settles the original task.
- Cursor errors use only the final segment's `\n\nError: ` prefix. Antigravity also recognizes quota, execution and connection-loss messages. Unknown prompt stop reasons keep completion unconfirmed.
- Permissions, Cursor questions and plan review are blocking interactions. Antigravity's `interaction_*` permission calls are single-choice questions. `cursor/task`, `cursor/update_todos` and `cursor/generate_image` requests get immediate acknowledgements; `cursor/task.agentId` never creates a child link.
- Input is queued while a prompt or visible child remains live. An unconfirmed shell rejects new and already queued input until a terminal native update settles it; the transport stays open to receive that evidence. Re-prompting cannot cancel the active turn. A targeted cascade sends cancellation only to that subtree and only where child cancellation is supported. Resolving an interaction checks its schema, kind, question IDs and options before replying; permission answers are encoded by the pending question ID. `stopTask` rejects because neither provider exposes individual task control.

Chunk handling retains each frame in the emitted raw item update without copying earlier chunk payloads. The current item's raw field holds its latest chunk; the append-only event log retains earlier updates. Tool items retain their initial frame, original nonempty input/name, current interpreted input fields, and the complete latest frame in two raw payloads. Every complete frame is emitted for the append-only log. Malformed input and name refreshes stay raw and cannot overwrite valid interpreted values. Unknown initial-frame metadata remains in later snapshots.

Partial input changes update a collector by top-level field, without copying its accumulated fields on each refresh. Live snapshots keep original input, current interpreted fields, and the latest complete change. Native completion or synthetic cancellation materializes the collected input in the canonical raw snapshot once; completed MCP details receive all collected arguments too. The event log preserves every intermediate value. Live interpretation carries a fixed set of fields used by tool mapping, plus the latest input change, rather than accumulating arbitrary keys. Terminal assembly costs the size of the final native input; ordinary refreshes do not republish that growing history. Error classification stores an 8 KiB prefix of each assistant segment; full text remains in canonical deltas. Live-tool and background-child indexes keep chunk work independent of past tools.

## Capabilities and limits

Cursor controls are enabled for discovered date versions at or after `2026.09.26`, the recorded version. Unrecognized and older versions get conservative controls. Antigravity controls are enabled for recognized server `1.2.x` and later `1.x` versions. Its implementation is experimental and has synthetic tests only.

Cursor always reports `backgroundVisibility: "none"`: ACP gives no reliable indication that a completed shell is still running. The background-shell fixture reaches core `done` at 16262 ms while its shell is unobservable. This must be qualified by clients using the capability. The interrupt fixture stays `waiting` on `background_task`, with an interrupted root and an uncertain unknown shell task. The added core `background.ended.uncertain` flag preserves that distinction without changing existing unknown-task semantics for other adapters. No terminal-directory side channel is implemented without recordings that establish its contract.

Generic ACP has conservative capabilities. Antigravity has partial background visibility and placeholder subagents. Neither provider supports native steering, fork, individual task control, usage reporting or file rewind here. Existing sessions use `session/load`; historical root traffic is bound before replay begins. Generic servers must support ACP v1 initialize and new/load. Versions that only speak v2 are rejected during initialization.

Child disconnects emit canonical `agent.disconnected` facts and produce `unresponsive` status unless a higher-priority live background task holds the thread waiting. Authoritative reassociation repairs the parent without moving the former parent’s spawning item. Core clears conflicting `spawnedBy` ownership with a nullable canonical update; the old item remains in its original transcript. A late replacement tool sets the new spawning link. Later refreshes of the historical item cannot undo the parent repair. Direct live traffic emits `agent.reconnected`. Unknown prompt results and stdout EOF reject active/queued input and terminate the owned process as an unexpected failure. A cancellation without child confirmation uses the same 12-second grace as translation, then rejects queued input and stops the process. Queueing never silently releases an unconfirmed turn. Routing uses a live-child set, key lookup, and parent adjacency index; ordinary notifications do not scan historical children.

## Verification

All eight Cursor recordings have `.expect.json` files and replay through `@ace/adapter-testkit`. Checkpoint notes explain the hidden-shell and core-precedence qualifications. The timeline CLI was run for every recording with the package's named `adapter` export.

```sh
bun run test packages/adapter-acp/src
bun run --filter @ace/adapter-testkit timeline /absolute/path/to/fixture.jsonl \
  --adapter /absolute/path/to/packages/adapter-acp/src/index.ts \
  --expect /absolute/path/to/scenario.expect.json
bun run check
```

The offline session tests use a real local fake JSON-RPC child process. No provider receives a prompt. `ACE_LIVE_CLI=1 bun run test packages/adapter-acp/src/live.test.ts` opts into initialize-only probes of installed Cursor and Antigravity binaries. The probes never call session/new, session/load or session/prompt. They were not run for this work.

Offline performance measurements and reproducible commands are in [PERFORMANCE.md](./PERFORMANCE.md). Mutation results, including the four review survivors, are in [MUTATION-VERIFICATION.md](./MUTATION-VERIFICATION.md).
