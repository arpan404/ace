# 0007: Provider adapter and engine contract

Date: 2026-10-02. Status: proposed. Depends on `@ace/core` (PR #1), `@ace/daemon` (PR #2) and `@ace/provider-kit` (PR #3).

## Context

Milestone 3 connects real CLIs. Four adapters (Claude, Codex, OpenCode, Cursor/ACP) will be built in parallel, so the boundary they share must be fixed first. The fixture analyses (`docs/research/fixtures/*.md`, section 4) already describe, per provider, how native frames map to core facts.

## Decision

### Adapter = translator + session

Each adapter has two parts:

1. **Translator** (pure, synchronous, no I/O): `translate(frame, now) → Fact[]` over its own small state. A frame is one raw native message in either direction, in the recorder's frame shape (`dir`, `channel`, `data`). All provider knowledge lives here: id mapping, synthesized turns, status rules, error-text classification and tool-kind mapping.
2. **Session** (I/O): spawns and talks to the CLI through `@ace/provider-kit`, feeds every frame (sent and received) to the translator, and executes commands. The session never decides status. It only reports frames and process lifecycle.

Because the translator is pure, the recorded fixtures are its contract tests: replay `fixtures/<provider>/<version>/*.jsonl` through translator → `core.apply`, then assert the thread status timeline.

### Interfaces (in a new package, `@ace/engine-api`, types only)

```ts
interface ProviderAdapter {
  readonly provider: ProviderKind;
  /** Probe the installed CLI (via provider-kit discovery) and report what this version supports. */
  capabilities(cli: DiscoveryResult): Capabilities;
  createTranslator(init: { threadId: ThreadId; rootKey: Key }): Translator;
  openSession(ctx: SessionContext): Promise<ProviderSession>;
}

interface Translator {
  /** Map one native frame to zero or more core facts. Never throws on provider data. */
  translate(frame: Frame, now: number): Fact[];
  /** Facts implied by time passing (grace windows, wake expiry). */
  tick(now: number): Fact[];
}

interface SessionContext {
  threadId: ThreadId;
  cwd: string;
  model?: string;
  /** Present when resuming an existing provider session. */
  resume?: { nativeSessionId: string };
  /** Every frame goes here; the engine translates, applies and persists. */
  onFrame(frame: Frame): void;
  onExit(exit: { deliberate: boolean; message?: string }): void;
  signal: AbortSignal; // engine-owned lifetime
}

interface ProviderSession {
  readonly nativeSessionId: string;
  /** Adapters without native steering queue internally until the turn settles. */
  send(input: ContentPart[], delivery: "steer" | "queue"): Promise<void>;
  interrupt(target: { agent?: Key; cascade: boolean }): Promise<void>;
  resolve(interaction: Key, resolution: InteractionResolution): Promise<void>;
  stopTask(task: Key): Promise<void>;
  close(reason: "idle" | "user" | "shutdown"): Promise<void>;
}
```

`Frame` is the recorder's frame type, moved into `@ace/engine-api` so the recorder, adapters and engine all share one definition.

### Engine (in `apps/daemon`)

- **One engine thread actor per ace thread.** It serialises: frame → `translator.translate` → `core.apply` for each fact → `store.appendEvents`. The core `ThreadState` snapshot is written **in the same SQLite transaction** as the events, so state and log never diverge. Core state can't be rebuilt from the log alone, because native keys aren't in events.
- **Commands become intents.** `CommandHandler.handle` validates the command and writes an `intents` row inside the receipt transaction, then returns `ok` (accepted). An intent worker runs provider I/O after commit (`send`, `interrupt`, `resolve`, `stopTask`). Failures become `notice` items, never silent drops.
- **Interactions resolve once.** `interaction.resolve` succeeds only while the interaction is `pending` in core state and no resolution intent exists yet. A second device gets `ok:false, error:"already_resolved"`.
- **Timers:** after every apply the engine reads `core.nextDeadline(state)` and keeps exactly one timer per thread. When it fires, the engine sends `tick` facts to both the translator and core.
- **Lifecycle:**
  - Sessions open lazily on the first `thread.send`.
  - Idle sessions (thread `done` for 30 min) close with `reason: "idle"` and resume on the next send. A `process.started` fact clears the previous exit in core.
  - Daemon shutdown closes sessions gracefully (`provider-kit` grace, then kill).
  - On startup, threads whose last state shows live work get a `process.exited{deliberate:false}`, so nothing stays "working" after a crash.
- **Queueing:** a queued `thread.send` is held by the engine and reported to core through `queue.changed`. It is sent when the thread reaches `done`, or immediately when `capabilities.steer` and delivery is `steer`.

### Contract tests

For each fixture there is an expectations file `fixtures/<provider>/<version>/<scenario>.expect.json`:

```json
{
  "checkpoints": [
    { "t": 4418, "thread": "waiting" },
    { "t": 9404, "thread": "done" }
  ],
  "final": { "thread": "done", "agents": 2, "interactions": { "resolved": 1 } }
}
```

The checkpoints come from the fixture analyses (e.g. Claude subagent-background: not done at 4418 or 6947, done at 9404). The adapter test replays the frames with `now = t`, applies the facts, and asserts every checkpoint and the final state. When a CLI version changes, record new fixtures, write their expectations, and keep the old ones until that version is dropped.

## Consequences

- Adapters can be built and fully tested in parallel against fixtures without running any agent session.
- Sessions stay thin and similar across providers. All four share provider-kit for processes, JSON-RPC and SSE.
- The engine owns ordering, persistence and timing. Core stays pure, and adapters stay unaware of storage.
