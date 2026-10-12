import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { AdapterRegistry, Engine, Store } from "@ace/daemon";
import { Capabilities, Command, CommandId, type CommandPayload } from "@ace/protocol";
import { expect, test } from "vitest";
import { changedTurnOptions } from "./composer/execution.ts";

test("an ordinary effort-capable follow-up promotes into the same running provider session", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-composer-steer-"));
  const store = new Store(join(home, "events.sqlite"), undefined, { now: () => 1000 });
  const adapter = createScriptedAdapter({
    provider: "codex",
    capabilities: Capabilities.parse({
      steer: true,
      interruptCascades: false,
      resume: true,
      fork: false,
      subagentTranscripts: true,
      backgroundTaskControl: false,
      backgroundVisibility: "full",
      planMode: false,
      tokenUsage: false,
      imageInput: true,
      rewindFiles: false,
    }),
    createTranslator: () => ({
      translate: () => [{ type: "turn.started", agent: "root", trigger: "user" }],
      tick: () => [],
    }),
    steps: [
      { on: "send", frames: [{ seq: 1, t: 1000, dir: "recv", channel: "scripted", data: {} }] },
    ],
  });
  const registry = new AdapterRegistry();
  registry.register(adapter, { installed: true, auth: "logged_in", loginHint: "scripted" });
  const engine = new Engine(store, {
    registry,
    clock: { now: () => 1000, setTimer: () => () => {} },
  });
  let serial = 0;
  const command = (payload: CommandPayload, id = `steer-${++serial}`) => {
    const value = Command.parse({ id, deviceId: "composer", payload });
    const result = store.recordCommand(value.id, value.deviceId, () =>
      engine.handler.handle(value, store),
    );
    if (!result.ok) throw new Error(result.error);
    return value.id;
  };
  try {
    const workspace = store.createWorkspace(home, "Composer");
    command({
      type: "thread.create",
      workspaceId: workspace,
      provider: "codex",
      model: "model",
      options: { effort: "medium" },
      input: [{ type: "text", text: "Keep working" }],
    });
    await engine.flush();
    const thread = store.listThreads()[0];
    if (!thread) throw new Error("Missing thread");
    expect(store.snapshotThread(thread.id).thread.status.state).toBe("working");
    const options = changedTurnOptions({ effort: "medium" }, { effort: "medium" });
    const followUp = command({
      type: "thread.send",
      threadId: thread.id,
      input: [{ type: "text", text: "Ordinary follow-up" }],
      delivery: "queue",
      ...(options ? { options } : {}),
    });
    await engine.flush();
    const queue = engine.queuePage({ threadId: thread.id });
    expect(queue.messages[0]?.requiresNextTurn).not.toBe(true);
    expect(adapter.commands.filter((entry) => entry.type === "send")).toHaveLength(1);
    command({
      type: "queue.edit",
      threadId: thread.id,
      messageId: followUp,
      expectedRevision: queue.revision,
      input: [{ type: "text", text: "Ordinary follow-up" }],
      delivery: "steer",
    });
    await engine.flush();
    expect(adapter.sessions).toHaveLength(1);
    expect(adapter.commands.filter((entry) => entry.type === "send")).toEqual([
      { type: "send", input: [{ type: "text", text: "Keep working" }], delivery: "queue" },
      { type: "send", input: [{ type: "text", text: "Ordinary follow-up" }], delivery: "steer" },
    ]);
    expect(store.snapshotThread(thread.id).thread.status.state).toBe("working");
    const next = command({
      type: "thread.send",
      threadId: thread.id,
      input: [{ type: "text", text: "Higher effort next turn" }],
      delivery: "queue",
      options: { effort: "high" },
    });
    expect(
      engine
        .queuePage({ threadId: thread.id })
        .messages.find((entry) => entry.id === CommandId.parse(next))?.requiresNextTurn,
    ).toBe(true);
  } finally {
    await engine.close();
    await store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
