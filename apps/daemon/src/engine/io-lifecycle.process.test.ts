import { afterEach, expect, test } from "vitest";
import { threadAttention } from "@ace/projection";
import { harness, scriptFrames, start, end } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const discovery = { installed: true, auth: "logged_in" as const, loginHint: "unused" };

test("interrupt reaches the provider while its send is still awaiting a turn response", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start)] },
      { on: "interrupt", frames: [frames.frame(end)] },
    ],
    frames,
  );
  cleanups.push(h.close);
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  h.registry.register(
    {
      ...h.adapter,
      async openSession(ctx) {
        const session = await h.adapter.openSession(ctx);
        ctx.signal.addEventListener("abort", () => released.resolve(), { once: true });
        return {
          ...session,
          async send(input, delivery) {
            await session.send(input, delivery);
            entered.resolve();
            await released.promise;
          },
          async interrupt(target) {
            try {
              await session.interrupt(target);
            } finally {
              released.resolve();
            }
          },
        };
      },
    },
    discovery,
  );
  h.command({
    type: "thread.create",
    workspaceId: h.workspace,
    provider: "codex",
    input: [{ type: "text", text: "run" }],
  });
  await entered.promise;
  const thread = h.store.listThreads()[0];
  if (!thread) throw new Error("Missing thread");
  h.command({ type: "thread.interrupt", threadId: thread.id, cascade: false });
  await h.engine.flush();
  expect(h.adapter.commands.filter((command) => command.type === "interrupt")).toEqual([
    { type: "interrupt", target: { cascade: false } },
  ]);
  const stopped = h.store.getThread(thread.id);
  expect(stopped?.status.state).toBe("done");
  expect(stopped?.queue).toMatchObject({ paused: true, reason: "stopped", pendingCount: 0 });
  expect(stopped && threadAttention(stopped)).toBe("stopped");
});

test("a control intent without a live session becomes a visible failure notice", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
    idleMs: 500,
  });
  cleanups.push(h.close);
  const id = await h.create();
  h.clock.advance(1500);
  await h.engine.flush();
  h.command({ type: "thread.interrupt", threadId: id, cascade: false });
  await h.engine.flush();
  const view = h.store.snapshotThread(id);
  expect(
    Object.values(view.items).some(
      (item) => item.type === "notice" && item.detail?.includes("Provider session is not live"),
    ),
  ).toBe(true);
  expect(h.adapter.commands.some((command) => command.type === "interrupt")).toBe(false);
});

test("idle expiry closes a done session even while its send response is still pending", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
    idleMs: 500,
  });
  cleanups.push(h.close);
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  h.registry.register(
    {
      ...h.adapter,
      async openSession(ctx) {
        const session = await h.adapter.openSession(ctx);
        ctx.signal.addEventListener("abort", () => released.resolve(), { once: true });
        return {
          ...session,
          async send(input, delivery) {
            await session.send(input, delivery);
            entered.resolve();
            await released.promise;
          },
        };
      },
    },
    discovery,
  );
  h.command({
    type: "thread.create",
    workspaceId: h.workspace,
    provider: "codex",
    input: [{ type: "text", text: "run" }],
  });
  await entered.promise;
  h.clock.advance(1500);
  await h.engine.flush();
  expect(h.adapter.commands.at(-1)).toEqual({ type: "close", reason: "idle" });
});

test("a retiring idle session cannot abort a newer resumed session", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
    idleMs: 500,
  });
  cleanups.push(h.close);
  const firstSend = Promise.withResolvers<void>();
  const oldSendResponse = Promise.withResolvers<void>();
  const closing = Promise.withResolvers<void>();
  const finishClose = Promise.withResolvers<void>();
  const resumed = Promise.withResolvers<void>();
  h.registry.register(
    {
      ...h.adapter,
      async openSession(ctx) {
        const session = await h.adapter.openSession(ctx);
        ctx.signal.addEventListener(
          "abort",
          () => {
            finishClose.resolve();
            oldSendResponse.resolve();
          },
          { once: true },
        );
        return {
          ...session,
          async close(reason) {
            if (!ctx.resume && reason === "idle") {
              closing.resolve();
              await finishClose.promise;
            }
            return session.close(reason);
          },
          async send(input, delivery) {
            await session.send(input, delivery);
            if (!ctx.resume) {
              firstSend.resolve();
              await oldSendResponse.promise;
            }
            if (ctx.resume) {
              ctx.onFrame(frames.frame(start, end));
              resumed.resolve();
            }
          },
        };
      },
    },
    discovery,
  );
  h.command({
    type: "thread.create",
    workspaceId: h.workspace,
    provider: "codex",
    input: [{ type: "text", text: "first" }],
  });
  await firstSend.promise;
  const thread = h.store.listThreads()[0];
  if (!thread) throw new Error("Missing thread");
  const id = thread.id;
  h.clock.advance(1500);
  await closing.promise;
  oldSendResponse.resolve();
  const payload = {
    type: "thread.send" as const,
    threadId: id,
    input: [{ type: "text" as const, text: "resumed" }],
    delivery: "queue" as const,
  };
  h.command(payload);
  await resumed.promise;
  finishClose.resolve();
  await h.engine.flush();
  h.command(payload);
  await h.engine.flush();
  expect(h.adapter.sessions).toHaveLength(2);
  expect(h.errors).toEqual([]);
  expect(h.store.getThread(id)?.status.state).toBe("done");
});

test("a resumed provider turn becomes working after an idle process exit", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
    idleMs: 500,
  });
  cleanups.push(h.close);
  const id = await h.create();
  h.clock.advance(1500);
  await h.engine.flush();
  h.registry.register(
    {
      ...h.adapter,
      async openSession(ctx) {
        const session = await h.adapter.openSession(ctx);
        return {
          ...session,
          async send(input, delivery) {
            await session.send(input, delivery);
            ctx.onFrame(frames.frame(start));
          },
        };
      },
    },
    discovery,
  );
  h.command({
    type: "thread.send",
    threadId: id,
    input: [{ type: "text", text: "resume" }],
    delivery: "queue",
  });
  await h.engine.flush();
  expect(h.store.getThread(id)?.status.state).toBe("working");
});

test("capable steering opens and resumes an idle provider before delivery", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
    steer: true,
    idleMs: 500,
  });
  cleanups.push(h.close);
  const id = await h.create();
  h.clock.advance(1500);
  await h.engine.flush();
  h.command({
    type: "thread.send",
    threadId: id,
    input: [{ type: "text", text: "steer after idle" }],
    delivery: "steer",
  });
  await h.engine.flush();
  expect(h.contexts[1]?.resume).toEqual({ nativeSessionId: "native-1" });
  expect(h.adapter.commands.at(-1)).toMatchObject({ type: "send", delivery: "steer" });
  expect(h.store.getThread(id)?.status.state).toBe("done");
});
