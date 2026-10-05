import { backup } from "node:sqlite";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Engine, Store } from "@ace/daemon";
import { Command } from "@ace/protocol";
import { applyEvent, createThreadView } from "@ace/projection";
import { harness, scriptFrames, start, end, question } from "./test-support.ts";

test("snapshot and replay preserve resolved native requests across restart without reopening tools", async () => {
  const frames = scriptFrames();
  const request = { ...question, interaction: "native-question", item: "native-question-tool" };
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, request)] },
      { on: "resolve", frames: [frames.frame(end)] },
    ],
    frames,
    { permissionSettings: async () => "ask" },
  );
  let restarted: Engine | undefined;
  let recoveredStore: Store | undefined;
  try {
    const id = await h.create();
    const original = Object.values(h.store.snapshotThread(id).interactions)[0];
    if (!original) throw new Error("No interaction");
    h.command({
      type: "interaction.resolve",
      interactionId: original.id,
      resolution: { kind: "approval", optionId: "yes" },
    });
    await h.engine.flush();
    const path = join(h.home, "restart-copy.sqlite");
    await backup(
      h.store.atomic((db) => db),
      path,
    );
    const base = h.registry.get("codex");
    h.registry.register(
      {
        ...base.adapter,
        async openSession(ctx) {
          await ctx.onFrame(
            frames.frame(
              { type: "process.started" },
              {
                type: "item.upsert",
                agent: "root",
                item: "native-question-tool",
                draft: {
                  type: "tool_call",
                  complete: false,
                  call: {
                    kind: "ask_user",
                    title: "Old question",
                    status: "awaiting_approval",
                    detail: { kind: "ask_user" },
                  },
                },
              },
              request,
            ),
          );
          const session = await base.adapter.openSession(ctx);
          session.send = async () => {
            await ctx.onFrame(frames.frame(start, end));
          };
          return session;
        },
      },
      base.discovery,
    );
    recoveredStore = new Store(path);
    restarted = new Engine(recoveredStore, { registry: h.registry, clock: h.clock });
    const cmd = Command.parse({
      id: "reopen",
      deviceId: "device",
      payload: {
        type: "thread.send",
        threadId: id,
        input: [{ type: "text", text: "continue" }],
      },
    });
    const engine = restarted;
    const store = recoveredStore;
    store.recordCommand(cmd.id, cmd.deviceId, () => engine.handler.handle(cmd, store));
    await restarted.flush();
    const snapshot = recoveredStore.snapshotThread(id);
    expect(Object.values(snapshot.interactions)).toEqual([
      expect.objectContaining({
        id: original.id,
        state: "resolved",
        resolution: { kind: "approval", optionId: "yes" },
      }),
    ]);
    expect(Object.values(snapshot.items).find((item) => item.type === "tool_call")?.complete).toBe(
      true,
    );
    const projected = createThreadView(snapshot.thread);
    for (const event of recoveredStore.readEvents({ afterSeq: 0, threadId: id, limit: 1000 })) {
      projected.seq = event.seq - 1;
      applyEvent(projected, event);
    }
    expect(projected.interactions).toEqual(snapshot.interactions);
  } finally {
    await restarted?.close();
    recoveredStore?.close();
    await h.close();
  }
});

test("provider exit expires unanswered requests and returns a typed expired receipt", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [{ on: "send", frames: [frames.frame(start, question)], exit: { deliberate: false } }],
    frames,
    { permissionSettings: async () => "ask" },
  );
  try {
    const id = await h.create();
    const interaction = Object.values(h.store.snapshotThread(id).interactions)[0];
    if (!interaction) throw new Error("No interaction");
    expect(interaction.state).toBe("expired");
    expect(
      h.command({
        type: "interaction.resolve",
        interactionId: interaction.id,
        resolution: { kind: "approval", optionId: "yes" },
      }),
    ).toMatchObject({
      ok: false,
      error: "interaction_expired",
      code: "interaction_expired",
      title: "Question expired",
      detail: expect.stringContaining("provider disconnected"),
    });
    expect(h.adapter.commands.filter((command) => command.type === "resolve")).toEqual([]);
  } finally {
    await h.close();
  }
});

test("an answer racing process exit expires and cannot resolve on a replacement session", async () => {
  const frames = scriptFrames();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const h = await harness([{ on: "send", frames: [frames.frame(start, question)] }], frames, {
    permissionSettings: async () => "ask",
  });
  const base = h.registry.get("codex");
  h.registry.register(
    {
      ...base.adapter,
      async openSession(ctx) {
        const session = await base.adapter.openSession(ctx);
        const resolve = session.resolve.bind(session);
        session.resolve = async (key, resolution) => {
          entered.resolve();
          await release.promise;
          return resolve(key, resolution);
        };
        return session;
      },
    },
    base.discovery,
  );
  try {
    const id = await h.create();
    const interaction = Object.values(h.store.snapshotThread(id).interactions)[0];
    const context = h.contexts[0];
    if (!interaction || !context) throw new Error("No live request");
    h.command(
      {
        type: "interaction.resolve",
        interactionId: interaction.id,
        resolution: { kind: "approval", optionId: "yes" },
      },
      "device",
      "racing-answer",
    );
    const flushing = h.engine.flush();
    try {
      await entered.promise;
      context.onExit({ deliberate: false });
    } finally {
      release.resolve();
    }
    await flushing;
    const view = h.store.snapshotThread(id);
    expect(view.interactions[interaction.id]).toMatchObject({
      state: "expired",
      expirationReason: "provider_disconnected",
    });
    const failures = Object.values(view.items).filter(
      (item) => item.type === "notice" && item.commandId === "racing-answer",
    );
    expect(failures).toEqual([
      expect.objectContaining({
        code: "interaction_expired",
        interactionId: interaction.id,
        text: expect.stringContaining("expired"),
        title: "This question is no longer active",
      }),
    ]);
    expect(h.contexts).toHaveLength(1);
  } finally {
    release.resolve();
    await h.close();
  }
});
