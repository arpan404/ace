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
