import { expect, test } from "vitest";
import { Store } from "@ace/daemon";
import { harness, scriptFrames, start, end } from "./test-support.ts";

test("confirmed model selection updates snapshots, resume and cold SQLite recovery", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  const original = h.registry.get("codex").adapter;
  h.registry.register(
    {
      ...original,
      async openSession(context) {
        const session = await original.openSession(context);
        return {
          ...session,
          async setModel(model: string) {
            if (model === "rejected") throw new Error("Rejected choice");
          },
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  try {
    const id = await h.create();
    expect(h.command({ type: "thread.model.set", threadId: id, model: "selected" }).ok).toBe(true);
    await h.engine.flush();
    expect(Object.values(h.store.snapshotThread(id).agents)[0]?.model).toBe("selected");
    h.command({ type: "thread.model.set", threadId: id, model: "rejected" });
    await h.engine.flush();
    expect(Object.values(h.store.snapshotThread(id).agents)[0]?.model).toBe("selected");
    h.contexts[0]?.onExit({ deliberate: false, message: "Synthetic replacement" });
    await h.engine.flush();
    h.command({
      type: "thread.send",
      threadId: id,
      delivery: "queue",
      input: [{ type: "text", text: "synthetic" }],
    });
    await h.engine.flush();
    expect(h.contexts[1]?.model).toBe("selected");
    const cold = new Store(h.path);
    try {
      expect(Object.values(cold.snapshotThread(id).agents)[0]?.model).toBe("selected");
    } finally {
      cold.close();
    }
  } finally {
    await h.close();
  }
});

test("retry after failed model persistence publishes the confirmed choice instead of reusing rolled-back state", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  const original = h.registry.get("codex").adapter;
  h.registry.register(
    {
      ...original,
      async openSession(context) {
        return { ...(await original.openSession(context)), async setModel() {} };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  try {
    const id = await h.create();
    h.store.atomic((db) =>
      db.exec(
        "CREATE TRIGGER reject_model BEFORE UPDATE OF model ON engine_sessions BEGIN SELECT RAISE(ABORT, 'Injected model persistence failure'); END",
      ),
    );
    h.command({ type: "thread.model.set", threadId: id, model: "retry-choice" });
    await h.engine.flush();
    expect(Object.values(h.store.snapshotThread(id).agents)[0]?.model).toBe("model");
    h.store.atomic((db) => db.exec("DROP TRIGGER reject_model"));
    h.command({ type: "thread.model.set", threadId: id, model: "retry-choice" });
    await h.engine.flush();
    expect(Object.values(h.store.snapshotThread(id).agents)[0]?.model).toBe("retry-choice");
    const cold = new Store(h.path);
    try {
      expect(Object.values(cold.snapshotThread(id).agents)[0]?.model).toBe("retry-choice");
    } finally {
      cold.close();
    }
  } finally {
    await h.close();
  }
});

test("create receipts return the admitted thread and next-turn selection reaches the provider before its input", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
  );
  const original = h.registry.get("codex").adapter;
  const delivered: {
    model: string | undefined;
    options: import("@ace/protocol").TurnOptions;
    text: string;
  }[] = [];
  h.registry.register(
    {
      ...original,
      capabilities: (cli) => ({ ...original.capabilities(cli), launchOptions: ["effort"] }),
      async openSession(context) {
        const session = await original.openSession(context);
        let model = context.model;
        let options = context.options ?? {};
        return {
          ...session,
          async configure(value) {
            model = value.model;
            options = value.options;
          },
          async send(input, delivery) {
            delivered.push({
              model,
              options,
              text: input.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
            });
            await session.send(input, delivery);
          },
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  try {
    const receipt = h.command(
      {
        type: "thread.create",
        workspaceId: h.workspace,
        provider: "codex",
        account: "personal",
        model: "first",
        options: { effort: "high" },
        input: [{ type: "text", text: "one" }],
      },
      "phone",
      "create",
    );
    expect(receipt.ok).toBe(true);
    if (!receipt.threadId) throw new Error("Missing admitted id");
    await h.engine.flush();
    h.command({
      type: "thread.send",
      threadId: receipt.threadId,
      model: "second",
      options: { effort: "low" },
      delivery: "queue",
      input: [{ type: "text", text: "two" }],
    });
    await h.engine.flush();
    expect(delivered).toEqual([
      { model: "first", options: { effort: "high" }, text: "one" },
      { model: "second", options: { effort: "low" }, text: "two" },
    ]);
    expect(h.store.getThread(receipt.threadId)?.live).toMatchObject({
      model: "second",
      account: "personal",
      options: { effort: "low" },
    });
    expect(Object.values(h.store.snapshotThread(receipt.threadId).agents)[0]?.model).toBe("second");
  } finally {
    await h.close();
  }
});

test("next-turn selection waits for the active run even when follow-ups default to steer", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
    { steer: true, preferences: { followUpBehavior: "steer" } },
  );
  const original = h.registry.get("codex").adapter;
  const delivered: { model: string | undefined; text: string; mode: string | undefined }[] = [];
  h.registry.register(
    {
      ...original,
      async openSession(context) {
        const session = await original.openSession(context);
        let model = context.model;
        return {
          ...session,
          async configure(selection) {
            model = selection.model;
          },
          async send(input, mode, commandId) {
            delivered.push({
              model,
              mode,
              text: input.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
            });
            await session.send(input, mode, commandId);
          },
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  try {
    const id = await h.create();
    expect(
      h.command({
        type: "thread.send",
        threadId: id,
        model: "next",
        delivery: "steer",
        input: [{ type: "text", text: "second" }],
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    expect(delivered).toEqual([{ model: "model", mode: "queue", text: "first" }]);
    h.contexts[0]?.onFrame(frames.frame(end));
    await h.engine.flush();
    expect(delivered).toEqual([
      { model: "model", mode: "queue", text: "first" },
      { model: "next", mode: "queue", text: "second" },
    ]);
    expect(h.store.getThread(id)?.live?.model).toBe("next");
  } finally {
    await h.close();
  }
});

test("a pause during checkpoint preparation prevents consumption until explicit resume", async () => {
  const frames = scriptFrames();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let serial = 0;
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
    {
      beforeSend: async () => {
        if (++serial === 2) {
          entered.resolve();
          await release.promise;
        }
      },
    },
  );
  try {
    const id = await h.create();
    h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "second" }] });
    await entered.promise;
    expect(
      h.command({
        type: "queue.pause",
        threadId: id,
        expectedRevision: h.engine.queue(id).revision,
      }).ok,
    ).toBe(true);
    release.resolve();
    await h.engine.flush();
    expect(h.adapter.commands.filter((command) => command.type === "send")).toHaveLength(1);
    expect(h.engine.queue(id)).toMatchObject({
      paused: true,
      messages: [expect.objectContaining({ input: [{ type: "text", text: "second" }] })],
    });
    expect(
      h.command({
        type: "queue.resume",
        threadId: id,
        expectedRevision: h.engine.queue(id).revision,
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    expect(h.adapter.commands.filter((command) => command.type === "send")).toHaveLength(2);
  } finally {
    release.resolve();
    await h.close();
  }
});
