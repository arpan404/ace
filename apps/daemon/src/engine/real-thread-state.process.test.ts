import { expect, test } from "vitest";
import { Engine, AdapterRegistry } from "@ace/daemon";
import { Command, CatalogModel } from "@ace/protocol";
import { ModelCatalog, ModelInstance } from "@ace/models";
import { legacyHandoff } from "@ace/fake-daemon";
import { harness, scriptFrames, start, end } from "./test-support.ts";

test("a send waits for provider activation and reaches the provider without a false failure", async () => {
  const entered = Promise.withResolvers<void>();
  const activated = Promise.withResolvers<void>();
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  await h.engine.close();
  const registry = new AdapterRegistry();
  const engine = new Engine(h.store, {
    registry,
    clock: h.clock,
    waitForProvider: async () => {
      entered.resolve();
      await activated.promise;
    },
  });
  try {
    const command = Command.parse({
      id: "activation-send",
      deviceId: "person",
      payload: {
        type: "thread.create",
        workspaceId: h.workspace,
        provider: "codex",
        input: [{ type: "text", text: "Wait for the connection" }],
      },
    });
    const prepared = engine.prepareCommand(command);
    await entered.promise;
    expect(h.adapter.commands.filter((sent) => sent.type === "send")).toEqual([]);
    registry.register(h.adapter, { installed: true, auth: "logged_in", loginHint: "unused" });
    activated.resolve();
    await prepared;
    expect(engine.handler.handle(command, h.store)).toMatchObject({ ok: true });
    await engine.flush();
    expect(h.adapter.commands).toContainEqual({
      type: "send",
      delivery: "queue",
      input: [{ type: "text", text: "Wait for the connection" }],
    });
    const thread = h.store.listThreads()[0];
    if (!thread) throw new Error("No created thread");
    expect(
      Object.values(h.store.snapshotThread(thread.id).items).filter(
        (item) => item.type === "notice" && item.code === "delivery_failed",
      ),
    ).toEqual([]);
  } finally {
    activated.resolve();
    await engine.close();
    await h.close();
  }
});

test("startup migrates a bare OpenCode model to its unique cached provider route", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
    provider: "opencode",
  });
  const receipt = h.command({
    type: "thread.create",
    workspaceId: h.workspace,
    provider: "opencode",
    model: "muse-spark-1.3-contributor",
    input: [{ type: "text", text: "Use the saved model" }],
  });
  if (!receipt.threadId) throw new Error("No created thread");
  const id = receipt.threadId;
  await h.engine.flush();
  await h.engine.close();
  const model = CatalogModel.parse({
    id: "opencode-go/muse-spark-1.3-contributor",
    provider: "opencode",
    instance: "opencode-cli-default",
    nativeModelId: "opencode-go/muse-spark-1.3-contributor",
    nativeProviderId: "opencode-go",
    displayName: "Muse Spark",
    reasoningEfforts: [],
    serviceTiers: [],
    inputModalities: ["text"],
    isDefault: true,
    hidden: false,
    deprecated: false,
    raw: { json: "{}", truncated: false },
  });
  const catalog = new ModelCatalog({
    instances: [
      ModelInstance.parse({
        id: model.instance,
        provider: "opencode",
        loginRevision: "synthetic",
        executable: "unused",
        cwd: h.home,
      }),
    ],
    storage: {
      load: () => [],
      replace() {},
      remove() {},
      close() {},
    },
    discover: async () => [model],
    now: () => h.clock.now(),
    deadline: () => () => {},
  });
  await catalog.refresh();
  const engine = new Engine(h.store, { registry: h.registry, clock: h.clock, models: catalog });
  try {
    await engine.ready();
    expect(h.store.getThread(id)?.execution?.model).toBe(model.id);
    const command = Command.parse({
      id: "next-turn",
      deviceId: "person",
      payload: { type: "thread.send", threadId: id, input: [{ type: "text", text: "Continue" }] },
    });
    expect(engine.handler.handle(command, h.store)).toMatchObject({ ok: true });
    await engine.flush();
    expect(h.contexts.at(-1)?.model).toBe(model.id);
  } finally {
    await engine.close();
    await catalog.close();
    await h.close();
  }
});

test("opening native history reconciles a joined handoff echo to the original null-generation input", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  const id = await h.create();
  await h.engine.close();
  h.store.atomic((db) =>
    db.prepare("UPDATE engine_inputs SET generation=NULL WHERE thread_id=?").run(id),
  );
  const original = h.registry.get("codex").adapter;
  h.registry.register(
    {
      ...original,
      async openSession(context) {
        await context.onFrame(
          frames.frame({
            type: "item.upsert",
            agent: "root",
            item: "legacy-native-first",
            draft: {
              type: "message",
              role: "user",
              nativeId: "native-first",
              parts: [{ type: "text", text: `${legacyHandoff}first` }],
              complete: true,
            },
          }),
        );
        return original.openSession(context);
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  const engine = new Engine(h.store, { registry: h.registry, clock: h.clock });
  try {
    const command = Command.parse({
      id: "follow-up",
      deviceId: "person",
      payload: { type: "thread.send", threadId: id, input: [{ type: "text", text: "next" }] },
    });
    expect(engine.handler.handle(command, h.store)).toMatchObject({ ok: true });
    await engine.flush();
    const inputs = Object.values(h.store.snapshotThread(id).items).filter(
      (item) => item.type === "message" && item.role === "user",
    );
    expect(inputs).toHaveLength(2);
    expect(inputs).toContainEqual(
      expect.objectContaining({
        nativeId: "native-first",
        parts: [{ type: "text", text: "first" }],
      }),
    );
  } finally {
    await engine.close();
    await h.close();
  }
});

test("a failed unsent message prevents settlement until its held queue is resumed", async () => {
  const frames = scriptFrames();
  let fail = false;
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
    {
      beforeSend: async () => {
        if (fail) throw new Error("The connection closed. Try again.");
      },
    },
  );
  try {
    const id = await h.create();
    fail = true;
    h.command(
      {
        type: "thread.send",
        threadId: id,
        input: [{ type: "text", text: "Retain this exact message" }],
      },
      "person",
      "retained",
    );
    await h.engine.flush();
    expect(h.engine.queue(id)).toMatchObject({
      paused: true,
      reason: "not_sent",
      messages: [{ id: "retained" }],
    });
    expect(h.store.getThread(id)?.status).toMatchObject({ state: "waiting", on: "queue" });
    expect(h.store.getThread(id)?.settledAt).toBeUndefined();
    fail = false;
    h.command({
      type: "queue.resume",
      threadId: id,
      expectedRevision: h.engine.queue(id).revision,
    });
    await h.engine.flush();
    expect(
      h.adapter.commands.filter(
        (command) =>
          command.type === "send" &&
          command.input.some(
            (part) => part.type === "text" && part.text === "Retain this exact message",
          ),
      ),
    ).toHaveLength(1);
    expect(h.store.getThread(id)?.status).toMatchObject({ state: "done" });
  } finally {
    await h.close();
  }
});
