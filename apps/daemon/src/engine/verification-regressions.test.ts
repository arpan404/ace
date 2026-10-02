import { afterEach, expect, test } from "vitest";
import { Command } from "@ace/protocol";
import { Engine, Store } from "@ace/daemon";
import { harness, scriptFrames, start, end } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const discovery = { installed: true, auth: "logged_in" as const, loginHint: "unused" };
const input = [{ type: "text" as const, text: "next" }];
function track<T extends Awaited<ReturnType<typeof harness>>>(h: T): T {
  cleanups.push(h.close);
  return h;
}

test("a failed provider open frees capacity and fences late callbacks before another thread opens", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
      limits: { maxActiveThreads: 1 },
    }),
  );
  h.registry.register(
    {
      ...h.adapter,
      async openSession(ctx) {
        h.contexts.push(ctx);
        throw new Error("probe open failure");
      },
    },
    discovery,
  );
  const failed = await h.create();
  expect(
    Object.values(h.store.snapshotThread(failed).items).some(
      (item) => item.type === "notice" && item.text.includes("probe open failure"),
    ),
  ).toBe(true);
  const old = h.contexts[0];
  if (!old) throw new Error("Missing failed lifetime");
  h.registry.register(h.adapter, discovery);
  expect(
    h.command({ type: "thread.create", workspaceId: h.workspace, provider: "codex", input }).ok,
  ).toBe(true);
  await h.engine.flush();
  old.onFrame(
    frames.frame({
      type: "item.delta",
      agent: "root",
      item: "late",
      field: "text",
      append: "retired output",
    }),
  );
  old.onExit({ deliberate: false, message: "late failed-open exit" });
  await h.engine.flush();
  expect(old.signal.aborted).toBe(true);
  expect(h.adapter.commands.filter((c) => c.type === "send")).toHaveLength(1);
  expect(h.store.listThreads().find((thread) => thread.id !== failed)?.status.state).toBe("done");
  expect(
    Object.values(h.store.snapshotThread(failed).items).some((item) => item.type === "message"),
  ).toBe(false);
});

test("steering before the first acknowledgement shares that delivery's turn and releases queued input", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness(
      [
        { on: "send" },
        { on: "send" },
        {
          on: "send",
          frames: [
            frames.frame({ ...start, nativeTurnId: "queued" }, { ...end, nativeTurnId: "queued" }),
          ],
        },
      ],
      frames,
      { steer: true },
    ),
  );
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const steered = Promise.withResolvers<void>();
  h.registry.register(
    {
      ...h.adapter,
      async openSession(ctx) {
        h.contexts.push(ctx);
        const session = await h.adapter.openSession(ctx);
        ctx.signal.addEventListener("abort", () => release.resolve(), { once: true });
        let first = true;
        return {
          ...session,
          async send(parts, delivery) {
            await session.send(parts, delivery);
            if (first) {
              first = false;
              entered.resolve();
              await release.promise;
            } else if (delivery === "steer") steered.resolve();
          },
        };
      },
    },
    discovery,
  );
  h.command({ type: "thread.create", workspaceId: h.workspace, provider: "codex", input });
  await entered.promise;
  const id = h.store.listThreads()[0]?.id;
  const ctx = h.contexts[0];
  if (!id || !ctx) throw new Error("Missing provider");
  h.command({ type: "thread.send", threadId: id, input, delivery: "steer" });
  await steered.promise;
  ctx.onFrame(frames.frame({ ...start, nativeTurnId: "first" }, { ...end, nativeTurnId: "first" }));
  release.resolve();
  await h.engine.flush();
  expect(h.adapter.commands.filter((c) => c.type === "send")).toHaveLength(2);
  expect(h.store.getThread(id)?.status.state).toBe("done");
  h.command({ type: "thread.send", threadId: id, input, delivery: "queue" });
  await h.engine.flush();
  expect(h.adapter.commands.filter((c) => c.type === "send")).toHaveLength(3);
  expect(h.store.getThread(id)?.status.state).toBe("done");
});

test("replacement retires accumulated journal before cold recovery", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness(
      [
        {
          on: "send",
          frames: [
            frames.frame(start, {
              type: "item.upsert",
              agent: "root",
              item: "answer",
              draft: {
                type: "message",
                role: "assistant",
                parts: [{ type: "text", text: "base" }],
              },
            }),
          ],
        },
        { on: "close" },
      ],
      frames,
    ),
  );
  const id = await h.create();
  const initial = h.contexts[0];
  if (!initial) throw new Error("Missing provider");
  initial.onFrame(
    frames.frame({
      type: "item.delta",
      agent: "root",
      item: "answer",
      field: "text",
      append: " old",
    }),
  );
  await h.engine.flush();
  initial.onFrame(
    frames.frame({
      type: "item.upsert",
      agent: "root",
      item: "answer",
      draft: { type: "message", parts: [{ type: "text", text: "replacement" }] },
    }),
  );
  await h.engine.flush();
  await h.engine.close();
  const store = new Store(h.path);
  const engine = new Engine(store, {
    registry: h.registry,
    clock: h.clock,
    onError: (e) => h.errors.push(e),
  });
  h.registry.register(
    {
      ...h.adapter,
      async openSession(ctx) {
        h.contexts.push(ctx);
        return h.adapter.openSession({
          ...ctx,
          onFrame: () => ctx.onFrame(frames.frame({ ...start, nativeTurnId: "resumed" })),
        });
      },
    },
    discovery,
  );
  try {
    const cmd = Command.parse({
      id: "resume-replacement",
      deviceId: "device",
      payload: { type: "thread.send", threadId: id, input, delivery: "queue" },
    });
    store.recordCommand(cmd.id, cmd.deviceId, () => engine.handler.handle(cmd, store));
    await engine.flush();
    const resumed = h.contexts.at(-1);
    if (!resumed) throw new Error("Missing resumed provider");
    resumed.onFrame(
      frames.frame({
        type: "item.delta",
        agent: "root",
        item: "answer",
        field: "text",
        append: " new",
      }),
    );
    await engine.flush();
    resumed.onFrame(
      frames.frame({
        type: "item.upsert",
        agent: "root",
        item: "answer",
        draft: { type: "message", complete: true },
      }),
    );
    await engine.flush();
    expect(
      Object.values(store.snapshotThread(id).items).find((item) => item.type === "message"),
    ).toMatchObject({ parts: [{ type: "text", text: "replacement new" }] });
    expect(h.errors).toEqual([]);
  } finally {
    await engine.close();
    store.close();
  }
});

test("late callbacks from a failed open cannot retire a newer session of the same thread", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness(
      [{ on: "send", frames: [frames.frame({ ...start, nativeTurnId: "fresh" })] }],
      frames,
      { limits: { maxActiveThreads: 1 } },
    ),
  );
  h.registry.register(
    {
      ...h.adapter,
      async openSession(context) {
        h.contexts.push(context);
        throw new Error("failed first lifetime");
      },
    },
    discovery,
  );
  const id = await h.create();
  const old = h.contexts[0];
  if (!old) throw new Error("Missing failed provider");
  h.registry.register(
    {
      ...h.adapter,
      async openSession(context) {
        h.contexts.push(context);
        return h.adapter.openSession(context);
      },
    },
    discovery,
  );
  expect(h.command({ type: "thread.send", threadId: id, input, delivery: "queue" }).ok).toBe(true);
  await h.engine.flush();
  const current = h.contexts.at(-1);
  if (!current || current === old) throw new Error("Missing new provider");
  old.onFrame(frames.frame({ ...end, nativeTurnId: "fresh" }));
  old.onExit({ deliberate: false, message: "late failure" });
  await h.engine.flush();
  expect(old.signal.aborted).toBe(true);
  expect(current.signal.aborted).toBe(false);
  expect(h.store.getThread(id)?.status.state).toBe("working");
  expect(
    h.command({ type: "thread.create", workspaceId: h.workspace, provider: "codex", input }).error,
  ).toBe("engine_capacity_exceeded");
});

test("commands owned by orchestration are declined without provider work or thread capacity", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
      limits: { maxActiveThreads: 1 },
    }),
  );
  const command = Command.parse({
    id: "other-owner",
    deviceId: "device",
    payload: { type: "orchestration.cancel", orchestrationId: "other" },
  });
  expect(
    h.store.recordCommand(command.id, command.deviceId, () =>
      h.engine.handler.handle(command, h.store),
    ),
  ).toMatchObject({ ok: false, error: "not_implemented" });
  await h.engine.flush();
  expect(h.store.headSeq()).toBe(0);
  expect(h.adapter.commands).toEqual([]);
  expect(
    h.command({ type: "thread.create", workspaceId: h.workspace, provider: "codex", input }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.adapter.commands.filter((c) => c.type === "send")).toHaveLength(1);
});
