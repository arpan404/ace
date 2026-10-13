import { afterEach, expect, test } from "vitest";
import type { Fact } from "@ace/core";
import { Command, type ThreadId } from "@ace/protocol";
import { organizeThread } from "../thread-organization.ts";
import { token } from "../socket-test-support.ts";
import { harness, scriptFrames, start, end, task } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
const idleMs = 5 * 60_000;
const input = [{ type: "text" as const, text: "next" }];
const child: Fact[] = [
  {
    type: "agent.seen",
    agent: "child",
    parent: "root",
    origin: "provider_subagent",
    fidelity: "full",
    native: { provider: "codex", nativeId: "child-native" },
    cwd: "/repo",
  },
  { type: "turn.started", agent: "child", trigger: "spawn" },
];
async function setup(
  steps: Parameters<typeof harness>[0],
  frames: ReturnType<typeof scriptFrames>,
) {
  const h = await harness(steps, frames, { idleMs });
  cleanups.push(h.close);
  const closes = () => h.adapter.commands.filter((command) => command.type === "close");
  const settle = (threadId: ThreadId) => {
    const command = Command.parse({
      id: crypto.randomUUID(),
      deviceId: "device",
      payload: { type: "thread.settle", threadId },
    });
    const result = organizeThread(h.store, command, h.clock.now());
    if (!result.ok) throw new Error(result.error);
  };
  // `ace status` reads this host route.
  const processes = async (threadId: ThreadId): Promise<unknown[]> => {
    const response = await fetch(`http://${new URL(h.url).host}/v1/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body: unknown = await response.json();
    const providers =
      typeof body === "object" && body !== null && "providers" in body ? body.providers : [];
    return Array.isArray(providers)
      ? providers.filter(
          (entry: unknown) =>
            typeof entry === "object" &&
            entry !== null &&
            "threadId" in entry &&
            entry.threadId === threadId,
        )
      : [];
  };
  const states = async (threadId: ThreadId) =>
    (await processes(threadId)).map((entry) =>
      typeof entry === "object" && entry !== null && "state" in entry ? entry.state : undefined,
    );
  return { ...h, closes, settle, processes, states };
}

test("a done thread keeps its provider warm for the idle window, then releases it", async () => {
  const frames = scriptFrames();
  const h = await setup([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  const id = await h.create();
  const doneAt = h.clock.now();
  expect(await h.processes(id)).toEqual([
    {
      threadId: id,
      provider: "codex",
      state: "idle-warm",
      idleSince: doneAt,
      releaseAt: doneAt + idleMs,
    },
  ]);
  h.clock.advance(doneAt + idleMs - 1);
  await h.engine.flush();
  expect(h.closes()).toEqual([]);
  h.clock.advance(doneAt + idleMs);
  await h.engine.flush();
  expect(h.closes()).toEqual([{ type: "close", reason: "idle" }]);
  expect(await h.processes(id)).toEqual([]);
  expect(h.store.getThread(id)?.status.state).toBe("done");
});

test("settling a done thread releases its provider at once and the next message resumes it", async () => {
  const frames = scriptFrames();
  const h = await setup(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
  );
  const id = await h.create();
  h.settle(id);
  await h.engine.flush();
  h.clock.advance(h.clock.now());
  await h.engine.flush();
  expect(h.closes()).toEqual([{ type: "close", reason: "idle" }]);
  expect(await h.processes(id)).toEqual([]);

  h.command({ type: "thread.send", threadId: id, input, delivery: "queue" });
  await h.engine.flush();
  expect(h.contexts).toHaveLength(2);
  expect(h.contexts[1]?.resume).toEqual({ nativeSessionId: "native-1" });
  expect(h.adapter.commands.filter((command) => command.type === "send")).toHaveLength(2);
  expect(h.store.getThread(id)?.status.state).toBe("done");
});

test("archiving a done thread releases its provider at once", async () => {
  const frames = scriptFrames();
  const h = await setup([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  const id = await h.create();
  const archived = h.command({ type: "thread.archive", threadId: id });
  expect(archived.ok).toBe(true);
  await h.engine.flush();
  h.clock.advance(h.clock.now());
  await h.engine.flush();
  expect(h.closes()).toEqual([{ type: "close", reason: "idle" }]);
});

test("a running background command keeps an archived thread's provider alive past the idle window", async () => {
  const frames = scriptFrames();
  const h = await setup(
    [
      { on: "send", frames: [frames.frame(start, task, end)] },
      {
        on: "stopTask",
        frames: [frames.frame({ type: "background.ended", task: "shell", status: "stopped" })],
      },
    ],
    frames,
  );
  const id = await h.create();
  h.command({ type: "thread.archive", threadId: id });
  await h.engine.flush();
  h.clock.advance(h.clock.now() + 10 * idleMs);
  await h.engine.flush();
  expect(h.closes()).toEqual([]);
  expect(await h.states(id)).toEqual(["busy"]);

  const taskId = Object.values(h.store.snapshotThread(id).backgroundTasks)[0]?.id;
  if (!taskId) throw new Error("Missing background task");
  h.command({ type: "background_task.stop", taskId });
  await h.engine.flush();
  h.clock.advance(h.clock.now());
  await h.engine.flush();
  expect(h.store.getThread(id)?.status.state).toBe("done");
  expect(h.closes()).toEqual([{ type: "close", reason: "idle" }]);
});

test("a live subagent keeps the provider alive however long the root has been idle", async () => {
  const frames = scriptFrames();
  const h = await setup([{ on: "send", frames: [frames.frame(start, ...child, end)] }], frames);
  const id = await h.create();
  expect(h.store.getThread(id)?.status.state).toBe("working");
  h.command({ type: "thread.archive", threadId: id });
  h.clock.advance(h.clock.now() + 10 * idleMs);
  await h.engine.flush();
  expect(h.closes()).toEqual([]);
  expect(await h.states(id)).toEqual(["busy"]);
});
