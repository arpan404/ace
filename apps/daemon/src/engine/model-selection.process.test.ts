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
