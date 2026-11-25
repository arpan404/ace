// SPDX-License-Identifier: Apache-2.0
/**
 * The TypeScript engine on a home the test hands it, for
 * `persistence-home.process.test.ts` (E5.3 constraint 2: a home written with the engine switch on
 * opens with it off, and the reverse).
 *
 * Runs in a child with `ACE_ENGINE` deleted, so the TypeScript engine is the one built. No
 * provider CLI and no daemon: a scripted adapter stands in for the provider, and the engine runs
 * in this process. Two modes:
 *
 * - `seed`: creates the threads the native engine then opens (a working one, a done one, one
 *   whose text is appended past 32,768 units, one whose header this build refuses), then exits.
 * - `continue`: opens the engine on the home, waits for readiness (the recovery restart), pushes
 *   one more scripted frame on the recovered session, and exits.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createScriptedAdapter, type ScriptedStep } from "@ace/adapter-testkit";
import { AdapterRegistry, Engine, Store } from "@ace/daemon";
import type { Fact } from "@ace/core";
import { Capabilities, Command, type CommandPayload } from "@ace/protocol";
import type { SessionContext } from "@ace/engine-api";
import { ManualClock, end, scriptFrames, start } from "../engine/test-support.ts";

const home = process.env.ACE_HOME;
if (!home) throw new Error("ACE_HOME is required");
const mode = process.argv[2] ?? "seed";

const frames = scriptFrames();
const clock = new ManualClock();
const contexts: SessionContext[] = [];
const errors: unknown[] = [];

/** The text long enough that its appended chunks stay split. */
export const LONG_DELTA = "x".repeat(1_000);

function message(item: string, text: string): Fact {
  return {
    type: "item.upsert",
    agent: "root",
    item,
    draft: {
      type: "message",
      role: "assistant",
      parts: [{ type: "text", text }],
      complete: true,
    },
  };
}

function delta(item: string, append: string): Fact {
  return { type: "item.delta", agent: "root", item, field: "text", append };
}

function adapter(steps: ScriptedStep[], received: SessionContext[]) {
  const scripted = createScriptedAdapter({
    provider: "codex",
    nativeSessionId: "native-1",
    capabilities: Capabilities.parse({
      steer: false,
      interruptCascades: false,
      resume: true,
      fork: false,
      subagentTranscripts: true,
      backgroundTaskControl: true,
      backgroundVisibility: "full",
      planMode: false,
      tokenUsage: false,
      imageInput: true,
      rewindFiles: false,
    }),
    createTranslator: () => ({ translate: frames.translate, tick: () => [] }),
    steps,
  });
  return {
    ...scripted,
    async openSession(context: SessionContext) {
      received.push(context);
      return scripted.openSession(context);
    },
  };
}

const store = new Store(join(home, "events.sqlite"));
const workspace = store.createWorkspace(home, "Home");
const registry = new AdapterRegistry();
const engine = new Engine(store, {
  registry,
  clock,
  idleMs: 30_000,
  silenceMs: 100,
  onError: (error) => errors.push(error),
});

function dispatch(payload: CommandPayload) {
  const command = Command.parse({ id: randomUUID(), deviceId: "device", payload });
  const result = store.recordCommand(command.id, command.deviceId, () =>
    engine.handler.handle(command, store),
  );
  if (!result.ok) throw new Error(result.error);
}

async function create(text: string): Promise<string> {
  dispatch({
    type: "thread.create",
    workspaceId: workspace,
    provider: "codex",
    model: "model",
    input: [{ type: "text", text }],
  });
  const thread = store.listThreads().at(-1);
  if (!thread) throw new Error("Missing created thread");
  await engine.flush();
  return thread.id;
}

try {
  if (mode === "seed") {
    registry.register(
      adapter(
        [
          { on: "send", frames: [frames.frame(start, message("working", "still going"))] },
          { on: "send", frames: [frames.frame(start, message("done", "finished"), end)] },
          {
            on: "send",
            frames: [
              frames.frame(
                start,
                message("long", ""),
                ...Array.from({ length: 40 }, () => delta("long", LONG_DELTA)),
                end,
              ),
            ],
          },
          { on: "send", frames: [frames.frame(start, message("refused", "refused"), end)] },
        ],
        contexts,
      ),
      { installed: true, auth: "logged_in", loginHint: "unused" },
    );
    await create("working");
    await create("done");
    await create("long");
    const refused = await create("refused");
    await engine.flush();
    // The header this build refuses: a snapshot version it does not read.
    store.atomic((db) =>
      db
        .prepare("UPDATE thread_state SET state=json_set(state,'$.engineSnapshot',8) WHERE thread_id=?")
        .run(refused),
    );
    process.stdout.write(`seed threads ${store.listThreads().map((thread) => thread.id).join(",")}\n`);
  } else if (mode === "continue") {
    // Recovery restarts the working thread: one send consumes this step.
    registry.register(adapter([{ on: "send" }], contexts), {
      installed: true,
      auth: "logged_in",
      loginHint: "unused",
    });
    await engine.ready();
    const context = contexts[0];
    if (!context) throw new Error("recovery opened no session");
    await context.onFrame(
      frames.frame(
        message("ts-after", "after"),
        { type: "turn.ended", agent: "root", outcome: "completed" },
      ),
    );
    await engine.flush();
    process.stdout.write(`continue contexts ${contexts.length}\n`);
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
  if (errors.length) process.stderr.write(`engine errors ${JSON.stringify(errors.map(String))}\n`);
} finally {
  await engine.close().catch(() => {});
  await store.close();
}
