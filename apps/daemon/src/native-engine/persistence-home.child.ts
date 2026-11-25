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
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { AdapterRegistry, Engine, Store } from "@ace/daemon";
import type { Fact } from "@ace/core";
import { Capabilities, Command, type CommandPayload } from "@ace/protocol";
import type { SessionContext } from "@ace/engine-api";
import { ManualClock, end, scriptFrames, start } from "../engine/test-support.ts";

const home = process.env.ACE_HOME;
if (!home) throw new Error("ACE_HOME is required");
const mode = process.argv[2] ?? "seed";
/** The thread whose header this build must refuse, written after the engine closed. */
let refused = "";

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
  // The live path refuses a delta batch past the thread's silence deadline; give it room.
  silenceMs: 30_000,
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
    // One adapter per thread: a scripted session consumes its own steps from the start.
    const register = (facts: Fact[]) => {
      registry.register(adapter([{ on: "send", frames: [frames.frame(...facts)] }], contexts), {
        installed: true,
        auth: "logged_in",
        loginHint: "unused",
      });
    };
    register([start, message("first", "still going"), end]);
    await create("first");
    register([start, message("done", "finished"), end]);
    await create("done");
    register([start, message("long", "")]);
    await create("long");
    // A second batch of deltas on the committed item; a frame of only deltas takes the live
    // path and is stored as patches.
    const longSession = contexts.at(-1);
    if (!longSession) throw new Error("the long thread opened no session");
    await longSession.onFrame(
      frames.frame(...Array.from({ length: 40 }, () => delta("long", LONG_DELTA))),
    );
    await longSession.onFrame(frames.frame(end));
    await engine.flush();
    register([start, message("refused", "refused")]);
    const refusedId = await create("refused");
    await engine.flush();
    refused = refusedId;
    process.stdout.write(
      `seed threads ${store
        .listThreads()
        .map((thread) => thread.id)
        .join(",")}\n`,
    );
  } else if (mode === "continue") {
    // The real frame path: a send opens the thread's session (its binding exists, as E5.6
    // writes it) and the scripted frame then folds through the actor.
    registry.register(adapter([{ on: "send" }], contexts), {
      installed: true,
      auth: "logged_in",
      loginHint: "unused",
    });
    await engine.ready();
    const thread = process.env.ACE_THREAD;
    if (!thread) throw new Error("ACE_THREAD is required");
    dispatch({
      type: "thread.send",
      threadId: thread as never,
      input: [{ type: "text", text: "again" }],
    });
    await engine.flush();
    const context = contexts.at(-1);
    if (!context) throw new Error("the send opened no session");
    await context.onFrame(
      frames.frame(message("ts-after", "after"), {
        type: "turn.ended",
        agent: "root",
        outcome: "completed",
      }),
    );
    await engine.flush();
    process.stdout.write(`continue contexts ${contexts.length}\n`);
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
  if (errors.length) throw new Error(`engine errors ${JSON.stringify(errors.map(String))}`);
} finally {
  await engine.close().catch(() => {});
  await store.close();
  if (refused) {
    // After the close's own flush: a header this build cannot read (a required section is gone),
    // which startup reports and skips. Written on a raw connection so no engine rewrites it.
    const raw = new DatabaseSync(join(home, "events.sqlite"));
    try {
      raw
        .prepare("UPDATE thread_state SET state=json_remove(state,'$.items') WHERE thread_id=?")
        .run(refused);
      // The scan's candidate status, so startup visits the thread it must skip.
      raw
        .prepare("UPDATE threads SET status=? WHERE id=?")
        .run(JSON.stringify({ state: "working", agents: 1 }), refused);
    } finally {
      raw.close();
    }
  }
}
