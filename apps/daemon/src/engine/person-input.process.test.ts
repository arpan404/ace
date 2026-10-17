import { afterEach, expect, test } from "vitest";
import { harness, scriptFrames, start, end, question, task } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const input = [{ type: "text" as const, text: "can you see my browser" }];
const sends = (h: Awaited<ReturnType<typeof harness>>) =>
  h.adapter.commands.filter((command) => command.type === "send").length;

test("a steer with no live turn starts the next turn while a dev server keeps running", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, task, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
  );
  cleanups.push(h.close);
  const id = await h.create();
  await h.engine.flush();
  expect(h.store.getThread(id)?.status).toEqual({ state: "waiting", on: "background_task" });
  h.command({ type: "thread.send", threadId: id, input, delivery: "steer" });
  await h.engine.flush();
  expect(h.adapter.commands.at(-1)).toMatchObject({ type: "send", input });
  expect(sends(h)).toBe(2);
  expect(h.engine.queue(id).messages).toEqual([]);
});

test("a provider's own question still holds the person's queued message", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, question)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
  );
  cleanups.push(h.close);
  const id = await h.create();
  h.command({ type: "thread.send", threadId: id, input, delivery: "queue" });
  await h.engine.flush();
  expect(h.store.getThread(id)?.status.state).toBe("needs_you");
  expect(sends(h)).toBe(1);
});
