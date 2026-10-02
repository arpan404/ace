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

The translator is synchronous and uses no I/O or clock. It emits raw notices immediately, including malformed primitives and unsupported subagent variants. Unconfirmed thread IDs share at most 256 compact metadata records and a 512-KiB encoded-size buffer: 256 frames overall, 64 per thread and 64 KiB per frame. They share one discovery guard and join the canonical tree after metadata identifies them. Evicting an unknown ID retains that guard until an authoritative loaded-thread scan. Fully evicted or truncated confirmed children retain their own recovery guard until a full `thread/read` snapshot succeeds. Raw facts are emitted before any eviction.

Closed item and turn identifiers use a 1,024-entry replay window per agent. Shell snapshots emit `item.reconciled`: core preserves canonical completion, the exact first raw input, and streamed output already covered by a repeated aggregate. Core owns bounded output summaries and emits missing suffixes through its existing stream writer. A nonextending aggregate stays in exact raw data; it cannot rewrite already emitted chunks or prevent tool completion. The translator does not retain growing shell output or use absence from the replay window to infer unfinished work. Live work and unresolved interactions remain tracked until resolved; keyed async closure uses an interaction-owner index. A child completion notice alone never ends child work. Surviving commands become shell tasks before completed or interrupted turns end, and complete by item ID when stale-turn events arrive. Output-only commands first observed after their turn ends also create stoppable tasks. Native `wait` tools emit `subagents.waiting` without changing their `agent.message` kind or raw name/input.

The session initializes with `experimentalApi: true` and forwards both directions, malformed input and stderr through `context.onFrame`. Interactive turn requests have no timeout. Control methods use adapter keys, not canonical IDs: `request:<id-type>:<id>` for server requests, `async:<itemId>` for asynchronous questions, `plan:<turnId>` for plan reviews, `shell:<itemId>` for terminals, and `subagent:<nativeThreadId>` for child tasks. The engine maps canonical IDs to these keys. Interrupt targets accept the root key `root` or a native child thread ID.

`send` starts a turn when idle, steers an active turn, or adds queued input to Codex's native queue. Server-side queue changes trigger paged reads and queue-count facts. `resolve` preserves offered approval decisions, sends native question envelopes, answers only the selected async question with steer or a new turn after confirmed delivery, and starts plan approval in default collaboration mode. Rejecting a plan with feedback starts another plan-mode turn. Cancelling or rejecting without feedback closes the review without sending input. `stopTask` lists all terminal pages to obtain the process ID. Cascading interrupts stop child turns and surviving terminals; plain interrupts leave them live.

Unknown child IDs trigger a metadata read after two seconds. Root turn completion starts loaded-thread reconciliation before the completion frame reaches the engine. A short discovery task keeps the thread unsettled until every loaded thread without recovered history has been read. Confirmed ancestry is tracked separately from successful history recovery. An admitted child schedules recovery even when the 256 unknown-thread timer slots are occupied; successful reads cancel pending retries. Loaded metadata is adopted only after proving an ancestry chain to this root. Metadata replies remain raw until that check succeeds. Failed discovery emits a diagnostic, retains the guard and retries after two seconds, including child recovery after its ancestry is known. Resume/read snapshots hydrate historical messages and pending command items. Start/resume controls are applied in wire order before subsequent notifications, and read controls are applied only if no newer control notification has arrived. `CodexOptions.runtime` injects the monotonic clock, scheduler and cancellation callbacks, message ID generator, discovery function, supervised spawner and process shutdown grace. Defaults live in the I/O module. Tests use a manual scheduler, zero shutdown grace and real offline processes. The default I/O shutdown grace remains five seconds. `close` owns process-group cleanup, pending interaction cleanup and timers. Unexpected exits go through `context.onExit` for the engine's process-exit fact.

## Protocol generation

```sh
bun run --cwd packages/adapter-codex generate
# Optional: ACE_CODEX_BIN=/absolute/path/to/codex
```

The dev script resolves the local binary through provider-kit and runs `codex app-server generate-ts --experimental`. It copies the dependency closure used by this adapter, adds `.ts` import extensions, formats it and records the CLI version in `src/generated/VERSION`. Generated definitions are types only. Native data is decoded leniently with Zod records and field guards; future fields remain in raw payloads.

## Verification

The repository owner requires tests to run once, at merge. During this fix round, run only static checks:

```sh
bun run fmt
bun run lint
bun run check:size
bun run typecheck
```

Tests, mutation runs, benchmarks and live CLI probes are not executed now. Their results need run at merge. The checked-in mutation cases are not executed (tests run at merge).

Offline tests replay every committed Codex fixture through `@ace/adapter-testkit` and core, with expectations at the analysis timestamps. Session tests run a fake provider in a real supervised process and synchronize on frames. The live test only initializes app-server and stops it. It never starts a thread or sends a prompt.

## Shared core behavior

The owner's integration rule keeps the thread `working` while any background child or descendant is working. A finished parent can remain `blocked/background_task` at the same time. Human input takes precedence over working; provider and background-task waits apply after active work settles. A successfully announced child remains `starting` through its silence grace; completing the spawn item cannot mark it immediately unresponsive. Native wait tools derive `blocked/subagents` from live target children. These fixes and the idempotent snapshot fact are isolated in the shared-core commit requested by the verifier follow-up.

Provider-native queue counts and engine-owned queued input also share one core `queue.changed` count. The daemon should combine these sources if it ever holds ace input while a native queue is nonempty.

Plan preview text streams through a companion notice with append-only `item.delta{text}` facts. The plan tool receives full markdown on completion, and review uses that authoritative native text. This uses the existing core API with linear emitted traffic. A native tool-markdown delta would let a future client render preview directly inside the plan tool.

Historical measurements below were collected before the owner stopped tests and benchmarks. Current performance validation needs run at merge. That plan run emitted 464,013 / 927,013 / 1,853,013 bytes for 1k / 2k / 4k 100-byte chunks, including final markdown and two plan-tool upserts each. With host load above 250, measured wall times were 35.66 / 116.40 / 35.68 ms and CPU times 10.73 / 24.67 / 20.29 ms. The 10,000-frame 4-KiB probes retained 0.44 MiB for one unknown ID and 0.35 MiB for 10,000 distinct IDs after GC and a far-future tick. Closing 10,000 questions took 143.65 / 157.35 / 221.37 / 149.02 ms with 1k / 2k / 4k / 10k historical agents; CPU times were 22.66 / 48.58 / 21.27 / 29.18 ms. Timings vary under host load and never gate tests. Traffic growth, replay recovery and canonical state assertions guard behavior.
