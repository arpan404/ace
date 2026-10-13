import { afterEach, expect, test } from "vitest";
import { harness, scriptFrames, start, end, question, task } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const input = [{ type: "text" as const, text: "can you see my browser" }];
const privateGate = {
  request: {
    kind: "plan_review" as const,
    title: "Private browser ownership",
    markdown: "Private browser control is held by a human.",
  },
  raw: [{ type: "ace.browser.private", data: { key: "browser-private:1" } }],
};

async function idleThread() {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
  );
  cleanups.push(h.close);
  const id = await h.create();
  await h.engine.flush();
  return { h, id, frames };
}
const sends = (h: Awaited<ReturnType<typeof harness>>) =>
  h.adapter.commands.filter((command) => command.type === "send").length;

test("handing back a private browser releases the queued message and the thread settles", async () => {
  const { h, id } = await idleThread();
  expect(h.store.getThread(id)?.status.state).toBe("done");
  h.engine.openHostApproval(id, "browser-private:1", privateGate.request, privateGate.raw);
  await h.engine.flush();
  expect(h.store.getThread(id)?.status.state).toBe("needs_you");
  h.command({ type: "thread.send", threadId: id, input, delivery: "queue" });
  await h.engine.flush();
  // The person owns the page privately: the agent stays paused until they hand back.
  expect(sends(h)).toBe(1);
  h.engine.closeHostGate(id, "browser-private:1", "resolved");
  await h.engine.flush();
  expect(sends(h)).toBe(2);
  expect(h.store.getThread(id)?.status.state).toBe("done");
});

test("a page held privately in one thread never holds another thread's message", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
  );
  cleanups.push(h.close);
  await h.create();
  await h.create();
  const [browsing, other] = h.store.listThreads().map((thread) => thread.id);
  if (!browsing || !other || browsing === other) throw new Error("Missing threads");
  await h.engine.flush();
  h.engine.openHostApproval(browsing, "browser-private:1", privateGate.request, privateGate.raw);
  await h.engine.flush();
  h.command({ type: "thread.send", threadId: other, input, delivery: "queue" });
  await h.engine.flush();
  expect(sends(h)).toBe(3);
  expect(h.store.getThread(other)?.status.state).toBe("done");
  expect(h.store.getThread(browsing)?.status.state).toBe("needs_you");
});

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
