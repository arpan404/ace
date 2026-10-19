import type { Fact } from "@ace/core";
import { Capabilities, type ProviderGoal } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { harness, scriptFrames, start, end } from "./test-support.ts";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});

const capabilities = (goals: boolean) =>
  Capabilities.parse({
    steer: false,
    interruptCascades: false,
    resume: true,
    fork: false,
    subagentTranscripts: true,
    backgroundTaskControl: true,
    backgroundVisibility: "full",
    planMode: false,
    tokenUsage: false,
    imageInput: true,
    rewindFiles: false,
    goals,
  });
const reported = (goal: ProviderGoal | null, agent = "root") =>
  ({ type: "goal.updated", agent, goal }) satisfies Fact;
const tests: ProviderGoal = { objective: "all tests pass", status: "active", tokensUsed: 1200 };

test("a goal set from ace reaches the provider, and the thread shows what the provider reports until it clears", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "goal", frames: [frames.frame(reported(tests))] },
      { on: "goal", frames: [frames.frame(reported({ ...tests, status: "paused" }))] },
      { on: "goal", frames: [frames.frame(reported(null))] },
    ],
    frames,
    { capabilities: capabilities(true) },
  );
  closes.push(h.close);
  const id = await h.create();

  expect(
    h.command({ type: "thread.goal.set", threadId: id, change: { objective: "all tests pass" } })
      .ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.adapter.commands.at(-1)).toEqual({
    type: "goal",
    change: { objective: "all tests pass" },
  });
  // Read back from the stored row: the goal outlives the session that reported it.
  expect(h.store.getThread(id)?.goal).toEqual(tests);

  h.command({ type: "thread.goal.set", threadId: id, change: { status: "paused" } });
  await h.engine.flush();
  expect(h.store.getThread(id)?.goal?.status).toBe("paused");

  h.command({ type: "thread.goal.clear", threadId: id });
  await h.engine.flush();
  expect(h.adapter.commands.at(-1)).toEqual({ type: "goal", change: "clear" });
  expect(h.store.getThread(id)?.goal).toBeUndefined();
});

test("a subagent's goal never becomes the thread's", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [{ on: "send", frames: [frames.frame(start, reported(tests, "child"), end)] }],
    frames,
    { capabilities: capabilities(true) },
  );
  closes.push(h.close);
  const id = await h.create();
  expect(h.store.getThread(id)?.goal).toBeUndefined();
});

test("a provider without native goals refuses goal commands before anything reaches it", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
    capabilities: capabilities(false),
  });
  closes.push(h.close);
  const id = await h.create();
  expect(
    h.command({ type: "thread.goal.set", threadId: id, change: { objective: "ship it" } }),
  ).toMatchObject({ ok: false, error: "unsupported_goal" });
  expect(h.command({ type: "thread.goal.clear", threadId: id })).toMatchObject({
    ok: false,
    error: "unsupported_goal",
  });
  await h.engine.flush();
  expect(h.adapter.commands.some((command) => command.type === "goal")).toBe(false);
});
