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

`createAcpTranslator` also accepts a quirk module directly. `openAcpSession` is the low-level process boundary for an already resolved executable. Its optional runtime injects the process spawner and monotonic clock. `nativeAgentKey(threadId, sessionId)` supplies the child keys accepted by `interrupt`; omitted targets or `root` address the root. Interaction keys are `request:<id type>:<rpc id>` and match the translator's facts.

Sessions forward sent and received JSON-RPC frames, malformed lines, stderr, queue changes and lifecycle notes through `SessionContext`. `onExit` also reports the owned process exit. Core ignores duplicate lifecycle facts. Close stops the process group through provider-kit and expires pending requests through process lifecycle facts.

## Translation and control

- Root prompts bracket user runs. Child traffic synthesizes spawn runs. Unknown child traffic creates a provisional child, and later associations repair its parent and spawning-tool link.
- Cursor's `subagent_spawned` and `subagent_state_update` coexist with draft `subagent_update`. Omitted or null draft state never proves completion. Child keys preserve opaque IDs, including newlines and invalid Unicode, without using them as filesystem paths.
- Tools are reclassified on refresh. Tool IDs are scoped to their session. Native names, input, output and unknown fields remain in raw payloads. Nonzero exit codes, errors and permission denial override `completed`; plan and permission rejections remain declined.
- Cursor background children have tracked tasks. The parent's held prompt is split when it waits for a background result, then resumes with `subagent_result`. Core's current precedence counts a working child as a working thread, even while the root is blocked on that task.
- A cancelled shell with no terminal update becomes a cancelled tool plus an unknown shell task. A child without a cancellation update gets a 12-second translator grace deadline, exposed to the engine through `wake.expected`, then an interrupted run and a synthetic raw note. Child background tasks become unknown.
- Cursor errors use only the final segment's `\n\nError: ` prefix. Antigravity also recognizes quota, execution and connection-loss messages. Unknown prompt stop reasons keep completion unconfirmed.
- Permissions, Cursor questions and plan review are blocking interactions. Antigravity's `interaction_*` permission calls are single-choice questions. `cursor/task`, `cursor/update_todos` and `cursor/generate_image` requests get immediate acknowledgements; `cursor/task.agentId` never creates a child link.
- Input is queued while a prompt or visible child remains live. Re-prompting cannot cancel the active turn. A targeted cascade sends cancellation only to that subtree and only where child cancellation is supported. Resolving an interaction checks its kind and options before replying. `stopTask` rejects because neither provider exposes individual task control.

Chunk handling retains each frame in the emitted raw item update without copying earlier chunk payloads. The current item's raw field holds its latest chunk; the append-only event log retains earlier updates. Tool items retain their accumulated native call and result frames. Live-tool and background-child indexes keep chunk work independent of past tools.

## Capabilities and limits

Cursor controls are enabled for discovered date versions at or after `2026.09.26`, the recorded version. Unrecognized and older versions get conservative controls. Antigravity controls are enabled for recognized server `1.2.x` and later `1.x` versions. Its implementation is experimental and has synthetic tests only.

Cursor always reports `backgroundVisibility: "none"`: ACP gives no reliable indication that a completed shell is still running. The background-shell fixture reaches core `done` at 16262 ms while its shell is unobservable. This must be qualified by clients using the capability. Unknown tasks currently permit completion in core, so the interrupt fixture also reaches `done`, with an interrupted root and an unknown shell task. No terminal-directory side channel is implemented without recordings that establish its contract.

Generic ACP has conservative capabilities. Antigravity has partial background visibility and placeholder subagents. Neither provider supports native steering, fork, individual task control, usage reporting or file rewind here. Existing sessions use `session/load`; historical root traffic is bound before replay begins. Generic servers must support ACP v1 initialize and new/load. Versions that only speak v2 are rejected during initialization.

Queueing stays conservative if a child disconnects or never confirms cancellation. The translator's grace can settle the child's canonical run, while an already queued session input still waits for native confirmation. The current session contract has no engine-to-session settled callback. See the PR's request for that contract addition rather than clearing native work on an unconfirmed timeout.

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
