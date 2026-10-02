import { afterEach, expect, test } from "vitest";
import { Engine, Store } from "@ace/daemon";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { harness, scriptFrames, start, end, question } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const input = [{ type: "text" as const, text: "next" }];
function track<T extends Awaited<ReturnType<typeof harness>>>(h: T): T {
  cleanups.push(h.close);
  return h;
}
const discovery = { installed: true, auth: "logged_in" as const, loginHint: "unused" };
function transcript(
  h: Awaited<ReturnType<typeof harness>>,
  id: Parameters<Store["snapshotThread"]>[0],
) {
  const view = h.store.snapshotThread(id);
  return view;
}

test("replayed and unrelated turn boundaries cannot acknowledge a new queued send", async () => {
  const frames = scriptFrames();
  const oldStart = { ...start, nativeTurnId: "old" };
  const oldEnd = { ...end, nativeTurnId: "old" };
  const h = track(
    await harness(
      [
        { on: "send", frames: [frames.frame(oldStart, oldEnd)] },
        { on: "send" },
        {
          on: "send",
          frames: [
            frames.frame({ ...start, nativeTurnId: "third" }, { ...end, nativeTurnId: "third" }),
          ],
        },
      ],
      frames,
    ),
  );
  const id = await h.create();
  h.command({ type: "thread.send", threadId: id, input, delivery: "queue" });
  await h.engine.flush();
  h.command({ type: "thread.send", threadId: id, input, delivery: "queue" });
  await h.engine.flush();
  const ctx = h.contexts[0];
  if (!ctx) throw new Error("Missing session");
  ctx.onFrame(
    frames.frame(
      oldEnd,
      oldStart,
      oldEnd,
      { type: "turn.started", agent: "child", trigger: "spawn", nativeTurnId: "child" },
      { type: "turn.ended", agent: "child", outcome: "completed", nativeTurnId: "child" },
      {
        type: "turn.started",
        agent: "root",
        trigger: "background_completion",
        nativeTurnId: "unsolicited",
      },
      { type: "turn.ended", agent: "root", outcome: "completed", nativeTurnId: "unsolicited" },
    ),
  );
  await h.engine.flush();
  expect(h.adapter.commands.filter((c) => c.type === "send")).toHaveLength(2);
  expect(h.store.getThread(id)?.status).toEqual({ state: "waiting", on: "queue" });
  ctx.onFrame(
    frames.frame({ ...start, nativeTurnId: "second" }, { ...end, nativeTurnId: "second" }),
  );
  await h.engine.flush();
  expect(h.adapter.commands.filter((c) => c.type === "send")).toHaveLength(3);
  expect(h.store.getThread(id)?.status.state).toBe("done");
});

test("shutdown persists frames accepted immediately before close and output emitted during close", async () => {
  const frames = scriptFrames();
  const h = track(await harness([{ on: "send", frames: [frames.frame(start)] }], frames));
  h.registry.register(
    {
      ...h.adapter,
      async openSession(ctx) {
        h.contexts.push(ctx);
        const session = await h.adapter.openSession(ctx);
        return {
          ...session,
          async close(reason) {
            ctx.onFrame(
              frames.frame({
                type: "item.delta",
                agent: "root",
                item: "answer",
                field: "text",
                append: " during close",
              }),
            );
            await session.close(reason);
          },
        };
      },
    },
    discovery,
  );
  const id = await h.create();
  const ctx = h.contexts[0];
  if (!ctx) throw new Error("Missing session");
  ctx.onFrame(
    frames.frame({
      type: "item.delta",
      agent: "root",
      item: "answer",
      field: "text",
      append: "before close",
    }),
  );
  await h.engine.close();
  expect(
    Object.values(transcript(h, id).items).find((item) => item.type === "message"),
  ).toMatchObject({
    parts: [{ type: "text", text: "before close during close" }],
  });
  expect(h.errors).toEqual([]);
});

test("restart reports an unacknowledged delivered send and clears its durable queue without another command", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness([{ on: "send", frames: [frames.frame(start, end)] }, { on: "send" }], frames),
  );
  const id = await h.create();
  h.command({ type: "thread.send", threadId: id, input, delivery: "queue" });
  await h.engine.flush();
  expect(h.store.getThread(id)?.status).toEqual({ state: "waiting", on: "queue" });
  const store = new Store(h.path);
  const engine = new Engine(store, { registry: h.registry, clock: h.clock });
  try {
    await engine.flush();
    const view = store.snapshotThread(id);
    expect(
      Object.values(view.items).some(
        (item) => item.type === "notice" && item.text.includes("uncertain"),
      ),
    ).toBe(true);
    expect(store.getThread(id)?.status.state).not.toBe("waiting");
    expect(h.adapter.commands.filter((c) => c.type === "send")).toHaveLength(2);
  } finally {
    await engine.close();
    store.close();
  }
});

test("capable steering is delivered before an outstanding ordinary send promise resolves", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness([{ on: "send", frames: [frames.frame(start)] }, { on: "send" }], frames, {
      steer: true,
    }),
  );
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const steered = Promise.withResolvers<void>();
  h.registry.register(
    {
      ...h.adapter,
      async openSession(ctx) {
        const session = await h.adapter.openSession(ctx);
        ctx.signal.addEventListener("abort", () => released.resolve(), { once: true });
        return {
          ...session,
          async send(parts, delivery) {
            await session.send(parts, delivery);
            if (delivery === "queue") {
              entered.resolve();
              await released.promise;
            } else {
              steered.resolve();
              released.resolve();
            }
          },
        };
      },
    },
    discovery,
  );
  h.command({ type: "thread.create", workspaceId: h.workspace, provider: "codex", input });
  await entered.promise;
  const id = h.store.listThreads()[0]?.id;
  if (!id) throw new Error("Missing thread");
  h.command({ type: "thread.send", threadId: id, input, delivery: "steer" });
  await steered.promise;
  await h.engine.flush();
  expect(h.adapter.commands.filter((c) => c.type === "send")).toEqual([
    { type: "send", input, delivery: "queue" },
    { type: "send", input, delivery: "steer" },
  ]);
});

test("an unoffered approval and a mismatched resolution kind leave the valid answer available", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness(
      [{ on: "send", frames: [frames.frame(start, question)] }, { on: "resolve" }],
      frames,
    ),
  );
  const id = await h.create();
  const interactionId = Object.values(transcript(h, id).interactions)[0]?.id;
  if (!interactionId) throw new Error("Missing interaction");
  expect(
    h.command({
      type: "interaction.resolve",
      interactionId,
      resolution: { kind: "question", answers: {} },
    }).error,
  ).toBe("invalid_resolution");
  expect(
    h.command({
      type: "interaction.resolve",
      interactionId,
      resolution: { kind: "approval", optionId: "invented" },
    }).error,
  ).toBe("invalid_resolution");
  expect(
    h.command({
      type: "interaction.resolve",
      interactionId,
      resolution: { kind: "approval", optionId: "yes" },
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.adapter.commands.filter((c) => c.type === "resolve")).toEqual([
    { type: "resolve", interaction: "approval", resolution: { kind: "approval", optionId: "yes" } },
  ]);
  expect(transcript(h, id).interactions[interactionId]?.state).toBe("resolved");
});

test("a regular file cannot be accepted as a workspace directory", async () => {
  const h = track(await harness([], scriptFrames()));
  const path = join(h.home, "file");
  writeFileSync(path, "file");
  const workspaceId = h.store.createWorkspace(path, "Invalid workspace");
  expect(h.command({ type: "thread.create", workspaceId, provider: "codex", input }).error).toBe(
    "workspace_unavailable",
  );
  await h.engine.flush();
  expect(h.store.listThreads()).toEqual([]);
  expect(h.adapter.commands).toEqual([]);
});

test("late frames from a retired session cannot enter the resumed transcript", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness(
      [
        { on: "send", frames: [frames.frame(start, end)] },
        { on: "send", frames: [frames.frame(start)] },
      ],
      frames,
      { idleMs: 500 },
    ),
  );
  h.registry.register(
    {
      ...h.adapter,
      async openSession(ctx) {
        h.contexts.push(ctx);
        const session = await h.adapter.openSession(ctx);
        return {
          ...session,
          async send(parts, delivery) {
            await session.send(parts, delivery);
            if (ctx.resume) ctx.onFrame(frames.frame(start));
          },
        };
      },
    },
    discovery,
  );
  const id = await h.create();
  const old = h.contexts[0];
  if (!old) throw new Error("Missing first session");
  h.clock.advance(1500);
  await h.engine.flush();
  h.command({ type: "thread.send", threadId: id, input, delivery: "queue" });
  await h.engine.flush();
  old.onFrame(
    frames.frame(
      { type: "item.delta", agent: "root", item: "retired", field: "text", append: "stale text" },
      end,
    ),
  );
  old.onFrame({ ...frames.frame(), seq: -1 });
  old.onFrame({ ...frames.frame(), data: "x".repeat(5 * 1024 * 1024) });
  await h.engine.flush();
  expect(h.store.getThread(id)?.status.state).toBe("working");
  expect(
    Object.values(transcript(h, id).items).some(
      (item) =>
        item.type === "message" &&
        item.parts.some((p) => p.type === "text" && p.text === "stale text"),
    ),
  ).toBe(false);
});

test("legacy untracked queue uncertainty is reported and reconciled on startup", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness([{ on: "send", frames: [frames.frame(start, end)] }, { on: "send" }], frames),
  );
  const id = await h.create();
  h.command({ type: "thread.send", threadId: id, input, delivery: "queue" });
  await h.engine.flush();
  // Version 1 marked delivery done without persisting acknowledgement ownership.
  h.store.atomic((db) => db.prepare("UPDATE intents SET awaiting=0").run());
  const store = new Store(h.path);
  const engine = new Engine(store, { registry: h.registry, clock: h.clock });
  try {
    await engine.flush();
    const result = store.snapshotThread(id);
    expect(store.getThread(id)?.status.state).toBe("done");
    expect(
      Object.values(result.items).some(
        (item) =>
          item.type === "notice" &&
          item.text.includes("untracked queue") &&
          item.text.includes("uncertain"),
      ),
    ).toBe(true);
  } finally {
    await engine.close();
    store.close();
  }
});

test("a valid answer with uncertain provider delivery retains its first-answer reservation", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness(
      [{ on: "send", frames: [frames.frame(start, question)] }, { on: "interrupt" }],
      frames,
    ),
  );
  const id = await h.create();
  const interactionId = Object.values(transcript(h, id).interactions)[0]?.id;
  if (!interactionId) throw new Error("Missing interaction");
  const payload = {
    type: "interaction.resolve" as const,
    interactionId,
    resolution: { kind: "approval" as const, optionId: "yes" },
  };
  expect(h.command(payload, "phone").ok).toBe(true);
  await h.engine.flush();
  expect(h.command(payload, "desktop").error).toBe("already_resolved");
  expect(transcript(h, id).interactions[interactionId]?.state).toBe("pending");
  expect(
    Object.values(transcript(h, id).items).some(
      (item) => item.type === "notice" && item.text.includes("expected interrupt, got resolve"),
    ),
  ).toBe(true);
});
