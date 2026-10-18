import { afterEach, expect, test } from "vitest";
import type { Fact } from "@ace/core";
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

const child = [
  {
    type: "agent.seen",
    agent: "child",
    parent: "root",
    background: true,
    origin: "provider_subagent",
    fidelity: "full",
    native: { provider: "codex", nativeId: "child" },
    cwd: "/repo",
  },
  { type: "turn.started", agent: "child", nativeTurnId: "child-turn", trigger: "spawn" },
] satisfies Fact[];
const childApproval = {
  type: "interaction.opened",
  agent: "child",
  interaction: "child-approval",
  blocking: true,
  request: {
    kind: "approval",
    title: "Run the migration?",
    options: [{ id: "yes", label: "Yes", kind: "allow_once" }],
  },
} satisfies Fact;

test("a queued message starts the next turn while a background subagent keeps working", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, ...child, end)] },
      { on: "send", frames: [frames.frame({ ...start, nativeTurnId: "next" })] },
    ],
    frames,
  );
  cleanups.push(h.close);
  const id = await h.create();
  await h.engine.flush();
  expect(h.store.getThread(id)?.status.state).toBe("working");
  h.command({ type: "thread.send", threadId: id, input, delivery: "queue" });
  await h.engine.flush();
  expect(h.adapter.commands.at(-1)).toMatchObject({ type: "send", input });
  expect(sends(h)).toBe(2);
  expect(h.engine.queue(id).messages).toEqual([]);
  // The subagent is still running: the thread must not read done after the message.
  h.contexts[0]?.onFrame(frames.frame({ ...end, nativeTurnId: "next" }));
  await h.engine.flush();
  expect(h.store.getThread(id)?.status.state).toBe("working");
});

test("a subagent's open approval never holds the person's message to the root", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, ...child, childApproval, end)] },
      { on: "send", frames: [frames.frame({ ...start, nativeTurnId: "next" })] },
    ],
    frames,
  );
  cleanups.push(h.close);
  const id = await h.create();
  await h.engine.flush();
  expect(h.store.getThread(id)?.status.state).toBe("needs_you");
  h.command({ type: "thread.send", threadId: id, input, delivery: "queue" });
  await h.engine.flush();
  expect(sends(h)).toBe(2);
  // The subagent's request is still the person's to answer.
  expect(h.store.getThread(id)?.status.state).toBe("needs_you");
});

test("a queued message changing the model still waits for a running subagent", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, ...child, end)] }], frames);
  cleanups.push(h.close);
  const id = await h.create();
  await h.engine.flush();
  h.command({
    type: "thread.send",
    threadId: id,
    input,
    delivery: "queue",
    options: { effort: "high" },
  });
  await h.engine.flush();
  expect(sends(h)).toBe(1);
  expect(h.engine.queue(id).messages).toHaveLength(1);
});
