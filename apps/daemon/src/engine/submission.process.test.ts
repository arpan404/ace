import { CommandId } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { harness, scriptFrames, start, end } from "./test-support.ts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

test("permission retirement cannot expire the unsent command for the replacement generation", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  cleanups.push(h.close);
  const id = await h.create();
  expect(h.command({ type: "thread.permission.set", threadId: id, permissionMode: "full-access" }).ok).toBe(true);
  h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "continue" }] }, "device", "permission-continue");
  await h.engine.flush();
  expect(h.adapter.commands.filter((command) => command.type === "send")).toEqual([
    { type: "send", input: [{ type: "text", text: "first" }], delivery: "queue" },
    { type: "send", input: [{ type: "text", text: "continue" }], delivery: "queue" },
  ]);
  expect(h.engine.queue(id)).toMatchObject({ paused: false, reason: null, messages: [] });
  expect(Object.values(h.store.snapshotThread(id).items).filter((item) => item.type === "notice" && item.level === "error")).toEqual([]);
});

test("exit after provider submission preserves an uncertain copy without automatic replay", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", exit: { deliberate: false, message: "lost transport" } }], frames);
  cleanups.push(h.close);
  const receipt = h.command({ type: "thread.create", workspaceId: h.workspace, provider: "codex",
    input: [{ type: "text", text: "might execute" }] }, "device", "submitted");
  if (!receipt.threadId) throw new Error("No thread");
  await h.engine.flush();
  expect(h.engine.queue(receipt.threadId)).toMatchObject({ paused: true, reason: "uncertain",
    messages: [{ id: "submitted", state: "uncertain" }] });
  expect(h.adapter.commands.filter((command) => command.type === "send")).toHaveLength(1);
});

test("removing the last uncertain copy clears its hold and identical resend owns its echo", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", exit: { deliberate: false } }], frames);
  cleanups.push(h.close);
  const receipt = h.command({ type: "thread.create", workspaceId: h.workspace, provider: "codex",
    input: [{ type: "text", text: "same input" }] }, "device", "removed");
  if (!receipt.threadId) throw new Error("No thread");
  const id = receipt.threadId;
  await h.engine.flush();
  const revision = h.engine.queue(id).revision;
  expect(h.command({ type: "queue.remove", threadId: id, messageId: CommandId.parse("removed"), expectedRevision: revision }).ok).toBe(true);
  expect(h.engine.queue(id)).toMatchObject({ paused: true, reason: "manual", messages: [] });
  expect(h.command({ type: "queue.remove", threadId: id, messageId: CommandId.parse("removed"), expectedRevision: revision })).toMatchObject({ ok: false, error: "queue_conflict" });
  const base = h.registry.get("codex");
  h.registry.register({ ...base.adapter, async openSession(ctx) {
    const session = await base.adapter.openSession(ctx);
    session.send = async () => { await ctx.onFrame(frames.frame(start,
      { type: "item.upsert", agent: "root", item: "replacement-native", draft: {
        type: "message", role: "user", parts: [{ type: "text", text: "same input" }], complete: true } }, end)); };
    return session;
  } }, base.discovery);
  h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "same input" }] }, "device", "replacement");
  h.command({ type: "queue.resume", threadId: id, expectedRevision: h.engine.queue(id).revision });
  await h.engine.flush();
  const view = h.store.snapshotThread(id);
  expect(view.items["input:removed"]).toBeUndefined();
  expect(view.items["input:replacement"]).toMatchObject({ parts: [{ type: "text", text: "same input" }], nativeId: "replacement-native" });
  expect(Object.values(view.items).filter((item) => item.type === "message")).toHaveLength(1);
});

test("uncertain resend atomically retires its original while preserving other messages and rejecting stale revisions", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", exit: { deliberate: false } }], frames);
  cleanups.push(h.close);
  const receipt = h.command({ type: "thread.create", workspaceId: h.workspace, provider: "codex",
    input: [{ type: "text", text: "ambiguous" }] }, "device", "original-ambiguous");
  if (!receipt.threadId) throw new Error("No thread");
  const id = receipt.threadId;
  await h.engine.flush();
  h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "other queued input" }] }, "device", "other-queued");
  h.command({ type: "queue.pause", threadId: id, expectedRevision: h.engine.queue(id).revision });
  const revision = h.engine.queue(id).revision;
  expect(h.command({ type: "queue.resend", threadId: id, messageId: CommandId.parse("original-ambiguous"),
    expectedRevision: revision }, "device", "resend-ambiguous").ok).toBe(true);
  expect(h.engine.queue(id)).toMatchObject({ paused: true, reason: "manual", messages: [
    { id: "other-queued", state: "queued" }, { id: "resend-ambiguous", state: "queued" },
  ] });
  expect(h.store.snapshotThread(id).items["input:original-ambiguous"]).toBeUndefined();
  expect(h.store.snapshotThread(id).items["input:resend-ambiguous"]).toMatchObject({ parts: [{ type: "text", text: "ambiguous" }] });
  expect(h.command({ type: "queue.resend", threadId: id, messageId: CommandId.parse("original-ambiguous"),
    expectedRevision: revision })).toMatchObject({ ok: false, error: "queue_conflict" });
});
