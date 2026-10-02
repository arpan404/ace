# @ace/adapter-codex

Local Codex app-server adapter for Node 24+. It uses the user's installed CLI and its existing login. It never handles provider credentials.

```ts
import { createCodexAdapter } from "@ace/adapter-codex";

const adapter = createCodexAdapter({
  discovery: { overrides: { codex: "/path/to/the/users/codex" } },
});
const translator = adapter.createTranslator({ threadId, rootKey: "root" });
const facts = translator.translate(frame, frame.t);
const session = await adapter.openSession(context);
```

The package also exports a default adapter, `createCodexTranslator`, and `codexCapabilities`. `CodexOptions.cli` accepts an already discovered `DiscoveryResult`; otherwise provider-kit resolves and probes the CLI. Version 0.159.1 is the verified minimum. Older, missing or unknown versions expose no experimental controls, and opening them fails with an actionable error.

The translator is synchronous and uses no I/O or clock. It retains unknown native data as raw notices, buffers undiscovered child frames, and replays them when spawn metadata or `thread/read` identifies their owner. A child completion notice alone never ends child work. Surviving command items become shell tasks before their turn ends, including interrupted turns, and complete by item ID when stale-turn events arrive.

The session initializes with `experimentalApi: true` and forwards both directions, malformed input and stderr through `context.onFrame`. Interactive turn requests have no timeout. Control methods use adapter keys, not canonical IDs: `request:<id-type>:<id>` for server requests, `async:<itemId>` for asynchronous questions, `plan:<turnId>` for plan reviews, `shell:<itemId>` for terminals, and `subagent:<nativeThreadId>` for child tasks. The engine maps canonical IDs to these keys. Interrupt targets accept the root key `root` or a native child thread ID.

`send` starts a turn when idle, steers an active turn, or adds queued input to Codex's native queue. Server-side queue changes trigger paged reads and queue-count facts. `resolve` preserves offered approval decisions, sends native question envelopes, answers async questions with steer or a new turn, and starts plan approval in default collaboration mode. Rejecting a plan with feedback starts another plan-mode turn. Cancelling or rejecting without feedback closes the review without sending input. `stopTask` lists all terminal pages to obtain the process ID. Cascading interrupts stop child turns and surviving terminals; plain interrupts leave them live.

Unknown child IDs trigger a metadata read after two seconds. Root turn completion starts loaded-thread reconciliation before the completion frame reaches the engine. A short discovery task keeps the thread unsettled until every loaded unknown thread has been read. Failed discovery emits a diagnostic and releases that task; discovered live work continues to hold completion. `close` owns process-group cleanup, pending interaction cleanup and timers. Unexpected exits go through `context.onExit` for the engine's process-exit fact.

## Protocol generation

```sh
bun run --cwd packages/adapter-codex generate
# Optional: ACE_CODEX_BIN=/absolute/path/to/codex
```

The dev script resolves the local binary through provider-kit and runs `codex app-server generate-ts --experimental`. It copies the dependency closure used by this adapter, adds `.ts` import extensions, formats it and records the CLI version in `src/generated/VERSION`. Generated definitions are types only. Native data is decoded leniently with Zod records and field guards; future fields remain in raw payloads.

## Verification

```sh
bun run test packages/adapter-codex
node packages/adapter-codex/scripts/mutations.ts
ACE_LIVE_CLI=1 bun run test packages/adapter-codex/src/live.test.ts
```

Offline tests replay every committed Codex fixture through `@ace/adapter-testkit` and core, with expectations at the analysis timestamps. Session tests run a fake provider in a real supervised process and synchronize on frames. The live test only initializes app-server and stops it. It never starts a thread or sends a prompt.

## Core contract requests

Three facts from the recordings need additional core support to match the analysis exactly:

- A background child with an active turn currently makes the thread `working`, even when its parent is blocked on a background task. The analysis calls that thread `waiting`. The subagent-background expectations record the current core result and require the root to remain blocked. The thread never becomes done before the child finishes.
- A successful spawn item can make a child `unresponsive` immediately, before its first turn. The child task still holds completion. Core should retain `starting` until a grace deadline or explicit evidence of failure.
- A native `wait` tool cannot express `blocked{subagents}` through the current Fact API. The adapter keeps the live tool as `agent.message` with its native name and input in raw data, so core displays tool work. A wait fact with target agent keys would let core derive the documented reason without mislabelling the tool as a spawn.

Provider-native queue counts and engine-owned queued input also share one core `queue.changed` count. The daemon should combine these sources if it ever holds ace input while a native queue is nonempty.

Plan markdown currently streams through full `item.upsert` facts because core's delta fields cannot append tool markdown. The non-gating `node packages/adapter-codex/bench/plan.ts` benchmark replayed the recorded plan in 38.5 ms, with 341 plan upserts containing 280,095 total markdown bytes. An additional markdown delta field would remove that repeated data. Correct plan rendering and review take precedence while that contract remains fixed.
