import { afterEach, expect, test } from "vitest";
import { createCodexTranslator } from "@ace/adapter-codex";
import { ThreadId, CommandId } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
import {
  fixture,
  cleanupRecovery,
  text,
  replaceProvider,
  resume,
  crashCopy,
  dispatch,
} from "./recovery-test-support.ts";
import { scriptFrames, start, end, task } from "./test-support.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ContextService } from "@ace/context";
import { prepareQueuedInput } from "../services/recovery.ts";
import type { PrepareInput } from "./input.ts";
import type { Fact } from "@ace/core";

afterEach(cleanupRecovery);
const quota: Fact = {
  type: "turn.ended",
  agent: "root",
  outcome: "failed",
  error: { kind: "quota", message: "Quota exhausted" },
};
const limit: Fact = { type: "retry", agent: "root", on: "rate_limit", until: 4000 };
function native(method: string, params: unknown, seq: number): Frame {
  return { seq, t: seq, dir: "recv", channel: "stdio", data: { method, params } };
}

test("surviving Codex shell output preserves Limited and every held message", async () => {
  const frames = scriptFrames();
  const scripted = frames.translate;
  const translator = createCodexTranslator({ threadId: ThreadId.parse("test"), rootKey: "root" });
  frames.translate = (frame) =>
    frame.channel === "stdio" ? translator.translate(frame, 1000) : scripted(frame);
  const h = await fixture(
    [{ on: "send", frames: [frames.frame(start, task, quota, limit)] }],
    frames,
  );
  const id = await h.create();
  h.command({ type: "thread.send", threadId: id, input: text("held") });
  await h.engine.flush();
  const before = h.engine.queue(id);
  h.contexts[0]?.onFrame(native("thread/started", { thread: { id: "native", cwd: h.home } }, 10));
  for (let i = 0; i < 32; i++) {
    h.contexts[0]?.onFrame(
      native(
        "item/commandExecution/outputDelta",
        {
          threadId: "native",
          itemId: "shell-output",
          delta: "x",
        },
        i + 11,
      ),
    );
    await h.engine.flush();
  }
  expect(h.store.getThread(id)?.status).toEqual({ state: "limited", until: 4000 });
  expect(h.engine.queue(id)).toEqual(before);
  expect(
    Object.values(h.store.snapshotThread(id).items).some(
      (item) =>
        item.type === "tool_call" &&
        item.call.detail?.kind === "shell" &&
        item.call.detail.output?.tail === "x".repeat(32),
    ),
  ).toBe(true);
  expect(h.adapter.commands.filter((command) => command.type === "send")).toHaveLength(1);
});

test("an acknowledged input rejected after quota is never replayed on native resume", async () => {
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [frames.frame(start, quota, limit)] }], frames);
  const adapter = h.registry.get("codex").adapter;
  h.registry.register(
    {
      ...adapter,
      async openSession(ctx) {
        const session = await adapter.openSession(ctx);
        return {
          ...session,
          async send(input, delivery) {
            await session.send(input, delivery);
            ctx.onExit({ deliberate: false, message: "RPC transport disconnected" });
            throw new Error("RPC response lost after consumption");
          },
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  const id = await h.create();
  expect(h.engine.queue(id).messages).toHaveLength(0);
  h.command({ type: "thread.send", threadId: id, input: text("following") });
  await h.engine.flush();
  const replacement = replaceProvider(h, frames, [
    { on: "send", frames: [frames.frame(start, end)] },
    { on: "send", frames: [frames.frame(start, end)] },
  ]);
  expect(resume(h, h.engine, id).ok).toBe(true);
  await h.engine.flush();
  const inputs = replacement.commands.flatMap((command) =>
    command.type === "send" ? [command.input] : [],
  );
  expect(inputs).toHaveLength(2);
  expect(inputs[1]).toEqual(text("following"));
  expect(inputs).not.toContainEqual(text("first"));
});

test("a quota-related rejection without acknowledgement stays uncertain instead of becoming replayable", async () => {
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [frames.frame(limit)] }], frames);
  const adapter = h.registry.get("codex").adapter;
  h.registry.register(
    {
      ...adapter,
      async openSession(ctx) {
        const session = await adapter.openSession(ctx);
        return {
          ...session,
          async send(input, delivery) {
            await session.send(input, delivery);
            throw new Error("RPC response lost without acknowledgement");
          },
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  const id = await h.create();
  expect(h.engine.queue(id).messages[0]?.state).toBe("uncertain");
  expect(resume(h, h.engine, id).error).toBe("uncertain_delivery");
});

for (const action of ["remove", "resume"] as const) {
  test(`a cold paused queue releases capacity after ${action}`, async () => {
    const frames = scriptFrames();
    const h = await fixture([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
      limits: { maxActiveThreads: 1 },
      idleMs: 10,
    });
    const id = await h.create();
    h.clock.advance(1010);
    await h.engine.flush();
    expect(h.engine.workload().activeSessions).toBe(0);
    h.command({ type: "queue.pause", threadId: id, expectedRevision: h.engine.queue(id).revision });
    if (action === "remove") {
      h.command({ type: "thread.send", threadId: id, input: text("discard") }, "device", "discard");
      await h.engine.flush();
      expect(
        h.command({
          type: "queue.remove",
          threadId: id,
          messageId: CommandId.parse("discard"),
          expectedRevision: h.engine.queue(id).revision,
        }).ok,
      ).toBe(true);
    } else expect(resume(h, h.engine, id).ok).toBe(true);
    await h.engine.flush();
    expect(
      h.command({
        type: "thread.create",
        workspaceId: h.workspace,
        provider: "codex",
        input: text("second"),
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    expect(h.engine.workload().activeSessions).toBe(1);
  });
}

test("pausing an opening provider retains its slot until the operation settles", async () => {
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
    limits: { maxActiveThreads: 1 },
  });
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const adapter = h.registry.get("codex").adapter;
  h.registry.register(
    {
      ...adapter,
      async openSession(ctx) {
        entered.resolve();
        await release.promise;
        return adapter.openSession(ctx);
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  h.command({
    type: "thread.create",
    workspaceId: h.workspace,
    provider: "codex",
    input: text("first"),
  });
  await entered.promise;
  const id = h.store.listThreads()[0]?.id;
  if (!id) throw new Error("Missing thread");
  h.command({ type: "queue.pause", threadId: id, expectedRevision: h.engine.queue(id).revision });
  expect(
    h.command({
      type: "thread.create",
      workspaceId: h.workspace,
      provider: "codex",
      input: text("second"),
    }).error,
  ).toBe("engine_capacity_exceeded");
  release.resolve();
  await h.engine.flush();
});

test("context resolution fallback reaches the notice stream and still sends the remaining input", async () => {
  const frames = scriptFrames();
  let prepare: PrepareInput | undefined;
  const h = await fixture(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
    {
      prepareInput: async (...args) => {
        if (!prepare) throw new Error("Preparation unavailable");
        return prepare(...args);
      },
    },
  );
  const id = await h.create();
  await promisify(execFile)("git", ["init", "-q", h.home]);
  const context = await ContextService.open({
    root: `${h.home}/context`,
    workspace: () => h.home,
    authorize: () => true,
    now: h.clock.now,
    id: () => "upload",
  });
  try {
    prepare = prepareQueuedInput({ services: { context } });
    h.command({
      type: "thread.send",
      threadId: id,
      input: text("inspect remaining input"),
      context: { mentions: [{ path: "missing.txt" }], attachments: [] },
    });
    await h.engine.flush();
    expect(
      Object.values(h.store.snapshotThread(id).items).some(
        (item) =>
          item.type === "notice" && item.level === "warning" && item.text.includes("missing.txt"),
      ),
    ).toBe(true);
    expect(h.adapter.commands.findLast((command) => command.type === "send")).toMatchObject({
      input: text("inspect remaining input"),
    });
  } finally {
    await context.close();
  }
});

test("durable acknowledgement survives a crash while the send response is still pending", async () => {
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [frames.frame(start, quota, limit)] }], frames);
  const quotaSeen = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const stop = h.store.subscribe((events) => {
    if (
      events.some(
        (event) =>
          event.payload.type === "thread.updated" && event.payload.status?.state === "limited",
      )
    )
      quotaSeen.resolve();
  });
  const adapter = h.registry.get("codex").adapter;
  h.registry.register(
    {
      ...adapter,
      async openSession(ctx) {
        const session = await adapter.openSession(ctx);
        return {
          ...session,
          async send(input, delivery) {
            await session.send(input, delivery);
            await release.promise;
          },
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  h.command({
    type: "thread.create",
    workspaceId: h.workspace,
    provider: "codex",
    input: text("consumed"),
  });
  try {
    await quotaSeen.promise;
    const id = h.store.listThreads()[0]?.id;
    if (!id) throw new Error("Missing thread");
    const replacement = replaceProvider(h, frames, [
      { on: "send", frames: [frames.frame(start, end)] },
    ]);
    const recovered = await crashCopy(h);
    expect(recovered.engine.queue(id).messages).toHaveLength(0);
    expect(
      dispatch(recovered.store, recovered.engine, {
        type: "thread.resume",
        threadId: id,
        expectedRevision: recovered.engine.queue(id).revision,
      }).ok,
    ).toBe(true);
    await recovered.engine.flush();
    const inputs = replacement.commands.flatMap((command) =>
      command.type === "send" ? [command.input] : [],
    );
    expect(inputs).toHaveLength(1);
    expect(inputs).not.toContainEqual(text("consumed"));
  } finally {
    stop();
    release.resolve();
    await h.engine.flush();
  }
});

test("provider exit during a limit cannot make an unacknowledged send replayable", async () => {
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [frames.frame(limit)] }], frames);
  const id = await h.create();
  h.contexts[0]?.onExit({ deliberate: false, message: "Quota transport exit" });
  await h.engine.flush();
  expect(h.engine.queue(id).messages[0]?.state).toBe("uncertain");
  expect(resume(h, h.engine, id).error).toBe("uncertain_delivery");
});
