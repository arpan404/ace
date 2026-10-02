# @ace/adapter-testkit

Offline contract tests for provider translators and daemon engines. No provider CLI runs.

```ts
import {
  readFixture,
  readExpectations,
  replayFixture,
  assertExpectations,
} from "@ace/adapter-testkit";

const fixture = await readFixture("fixtures/claude/2.1.286/background-shell.jsonl");
const expected = await readExpectations("fixtures/claude/2.1.286/background-shell.expect.json");
const result = replayFixture({
  createTranslator: (init) => adapter.createTranslator(init),
  fixture,
  coreConfig: { provider: adapter.provider, silenceMs: 90_000 },
  checkpoints: expected.checkpoints.map((point) => point.t),
});
assertExpectations(result, expected);
```

`readFixture` validates the `ace-recording/v1` header, frame envelope and recorded order. It preserves unknown header/frame fields and native data. Blank lines are ignored; parse failures include the file and line number.

Replay uses a fresh translator and core state, deterministic IDs, and `now = frame.t`. All directions and channels reach the translator. At each unique frame or checkpoint time, it applies frames in recorded order, then translator tick facts, then a core tick. Equal-time checkpoints observe all frames at that time. Extra checkpoints may precede or follow the recording. Replay does not invent process lifecycle facts or run timers beyond these times; adapters must translate lifecycle notes. The default root key is `root`, overridable with `rootKey`.

Timeline agent keys are core's adapter-owned keys. `final.view` is the client view folded from emitted core events through `@ace/projection`. `final.thread` is its full status; `final.agents`, `final.items` and `final.interactions` count projected entities. Counts include zero values and historical resolved/expired interactions.

Expectation JSON contains `checkpoints` and `final`. Both use `thread` as a status state and may specify `on` for waiting and `agentStates` keyed by native agent key. Checkpoints accept `note`; final accepts an agent count and partial counts by item type and interaction state. Omitted counts are unconstrained. Every own native key is validated and kept, including `__proto__` and `constructor`. Checkpoint assertions build a timestamp index once. Provider workers own their expectation files.

Print a timeline with an adapter module exporting a default `ProviderAdapter` or a named `adapter`:

```sh
bun run --filter @ace/adapter-testkit timeline /absolute/path/to/fixture.jsonl --adapter /absolute/path/to/adapter.ts
```

The filtered command runs in the package directory, so use absolute paths or paths relative to that directory. Workspace package names also work for `--adapter`. Optional `--expect <file>` adds its checkpoint times, `--checkpoint <ms>` adds an instant and may be repeated, `--silence-ms <ms>` changes core liveness, and `--root-key <key>` selects the root key. The CLI validates the imported adapter and translator methods before replay and names the module in interface failures. Each output line is JSON, followed by a final count summary.

`createScriptedAdapter({ provider, capabilities, createTranslator, nativeSessionId?, steps })` creates a fake adapter. Each step has `on: "open" | "send" | "interrupt" | "resolve" | "stopTask" | "close"`, optional `frames`, and optional `exit`. The next command consumes the next step; a wrong command rejects with the expected trigger. An initial open step emits during `openSession`. Once steps run out, commands are still recorded. Frames and command inputs are copied, emitted in script order without sleeps, and each session gets a fresh cursor. Inspect `adapter.commands` or `adapter.sessions[i].commands`. Command emission is serialized, including commands invoked from a frame callback. Close tears down even when its script step mismatches or a callback throws, while its promise still reports that diagnostic. Close and abort report deliberate exit once; commands after exit reject. Failed opening callbacks roll back session registration and release the abort listener. Engines translate the supplied frames and own core/persistence behavior.
