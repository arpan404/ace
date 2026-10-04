import { afterEach, expect, test } from "vitest";
import { harness, scriptFrames, start, end } from "./test-support.ts";
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});
const title = (text: string) =>
  ({
    type: "item.upsert",
    agent: "root",
    item: "provider:title",
    draft: {
      type: "notice",
      code: "thread_title",
      title: text,
      text,
      level: "info",
      complete: true,
    },
  }) as const;
test("creation titles use the first prose line without markdown, mentions or file chips", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  closes.push(h.close);
  const result = h.command({
    type: "thread.create",
    workspaceId: h.workspace,
    provider: "codex",
    input: [
      { type: "file", path: "/private/image.png" },
      {
        type: "text",
        text: "\n # **Fix** @agent [file: image.png] the [login](https://example.com) redirect\nIgnore this line",
      },
    ],
  });
  if (!result.threadId) throw new Error("No thread");
  expect(h.store.getThread(result.threadId)).toMatchObject({
    title: "Fix the login redirect",
    titleSource: "provisional",
  });
  await h.engine.flush();
});
test("provider titles replace provisional titles but preserve person and agent titles", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, title("Provider title"), end)] },
      { on: "send", frames: [frames.frame(start, title("Another provider title"), end)] },
    ],
    frames,
  );
  closes.push(h.close);
  const id = await h.create();
  expect(h.store.getThread(id)).toMatchObject({ title: "Provider title", titleSource: "provider" });
  h.store.appendEvents(id, [{ type: "thread.updated", title: "My title", titleSource: "person" }]);
  h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "follow up" }] });
  await h.engine.flush();
  expect(h.store.getThread(id)).toMatchObject({ title: "My title", titleSource: "person" });
  expect(
    Object.values(h.store.snapshotThread(id).items).filter(
      (item) => item.type === "notice" && item.code === "thread_title",
    ),
  ).toHaveLength(0);
});
test("long provisional titles end at a word boundary within sixty characters", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  closes.push(h.close);
  const result = h.command({
    type: "thread.create",
    workspaceId: h.workspace,
    provider: "codex",
    input: [
      {
        type: "text",
        text: "Investigate reconnect failures while multiple desktop windows send simultaneous queued messages",
      },
    ],
  });
  if (!result.threadId) throw new Error("No thread");
  expect(h.store.getThread(result.threadId)?.title).toBe(
    "Investigate reconnect failures while multiple desktop…",
  );
  await h.engine.flush();
});
