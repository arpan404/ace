import { Engine, Store } from "@ace/daemon";
import { afterEach, expect, test } from "vitest";
import { harness, scriptFrames, start, end } from "./test-support.ts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
test("interrupt keeps one queued send paused after Stop, including after reload", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start)] },
      { on: "interrupt", frames: [frames.frame({ ...end, outcome: "interrupted" })] },
    ],
    frames,
  );
  cleanups.push(h.close);
  const id = await h.create();
  const runId = Object.values(h.store.snapshotThread(id).runs)[0]?.id;
  const queued = h.command(
    {
      type: "thread.send",
      threadId: id,
      input: [{ type: "text", text: "queued" }],
      delivery: "queue",
    },
    "device",
    "queued",
  );
  expect(queued).toMatchObject({ ok: true });
  expect(h.engine.queue(id).messages).toHaveLength(1);
  expect(h.command({ type: "thread.interrupt", threadId: id, cascade: true, runId })).toMatchObject(
    { ok: true },
  );
  await h.engine.flush();
  expect(h.engine.queue(id)).toMatchObject({
    paused: true,
    reason: "stopped",
    messages: [{ id: "queued", input: [{ type: "text", text: "queued" }] }],
  });
  await h.engine.close();
  const reopened = new Store(h.path);
  const recovered = new Engine(reopened, { registry: h.registry, clock: h.clock });
  try {
    expect(recovered.queue(id)).toMatchObject({
      paused: true,
      reason: "stopped",
      messages: [{ id: "queued" }],
    });
  } finally {
    await recovered.close();
    reopened.close();
  }
  expect(h.store.snapshotThread(id).items["input:queued"]).toMatchObject({
    parts: [{ type: "text", text: "queued" }],
  });
});
test("a Stop for an ended run refuses to interrupt a later run", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start)] },
    ],
    frames,
  );
  cleanups.push(h.close);
  const id = await h.create();
  const oldRun = Object.values(h.store.snapshotThread(id).runs)[0]?.id;
  h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "new turn" }] });
  await h.engine.flush();
  expect(
    h.command({ type: "thread.interrupt", threadId: id, cascade: true, runId: oldRun }),
  ).toMatchObject({ ok: false, error: "stale_interrupt" });
  expect(h.store.getThread(id)?.status.state).toBe("working");
  expect(h.engine.queue(id).paused).toBe(false);
});

test("Stop before provider startup pauses the admitted input without opening a provider", async () => {
  const frames = scriptFrames();
  const h = await harness([], frames);
  cleanups.push(h.close);
  const receipt = h.command(
    {
      type: "thread.create",
      workspaceId: h.workspace,
      provider: "codex",
      input: [{ type: "text", text: "first request" }],
    },
    "device",
    "early-create",
  );
  if (!receipt.threadId) throw new Error("Missing thread");
  expect(
    h.command({ type: "thread.interrupt", threadId: receipt.threadId, cascade: true }),
  ).toMatchObject({ ok: true });
  await h.engine.flush();
  expect(h.contexts).toHaveLength(0);
  expect(h.engine.queue(receipt.threadId)).toMatchObject({
    paused: true,
    reason: "stopped",
    messages: [{ id: "early-create" }],
  });
  expect(h.store.snapshotThread(receipt.threadId).items["input:early-create"]).toMatchObject({
    parts: [{ type: "text", text: "first request" }],
  });
});
