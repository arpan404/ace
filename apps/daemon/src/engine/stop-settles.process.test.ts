import { afterEach, expect, test } from "vitest";
import type { Fact } from "@ace/core";
import type { ThreadId } from "@ace/protocol";
import { INTERRUPT_GRACE_MS } from "../liveness/stop.ts";
import { cleanupRecovery, fixture, restart } from "./recovery-test-support.ts";
import { end, scriptFrames, start, task } from "./test-support.ts";

/*
 * A Stop always settles the thread. Background work the provider can't stop, or that died
 * without the provider saying so, never keeps a stopped thread working or waiting.
 */
afterEach(cleanupRecovery);

/** A thread whose turn ended while a background shell it started still runs (done, ADR 0116). */
async function waitingOnShell(stop: { frames?: []; fail?: string }) {
  const frames = scriptFrames();
  const h = await fixture(
    [
      { on: "send", frames: [frames.frame(start, task, end)] },
      { on: "interrupt", ...stop },
    ],
    frames,
  );
  const id = await h.create();
  expect(h.store.getThread(id)?.status).toEqual({ state: "done" });
  expect(Object.values(h.store.snapshotThread(id).backgroundTasks)).toMatchObject([
    { status: "running" },
  ]);
  return { h, id };
}

const taskStatuses = (h: Awaited<ReturnType<typeof fixture>>, id: ThreadId) =>
  Object.values(h.store.snapshotThread(id).backgroundTasks).map((entry) => entry.status);

test("stopping a thread whose provider can't stop its background task still settles it", async () => {
  const { h, id } = await waitingOnShell({ fail: "OpenCode location is unavailable" });
  expect(h.command({ type: "thread.interrupt", threadId: id, cascade: true }).ok).toBe(true);
  await h.engine.flush();
  // A whole-thread Stop also asks the provider to stop the shell; when that fails too, ace
  // closes the session.
  expect(h.adapter.commands.map((command) => command.type)).toEqual([
    "send",
    "interrupt",
    "stopTask",
    "close",
  ]);
  expect(taskStatuses(h, id)).toEqual(["unknown"]);
  expect(h.store.getThread(id)?.status.state).toBe("done");
  const notices = Object.values(h.store.snapshotThread(id).items).filter(
    (item) => item.type === "notice" && item.level === "error",
  );
  expect(notices).toEqual([]);
});

test("a stopped thread whose background task never reported ending is not resumed after a restart", async () => {
  const { h, id } = await waitingOnShell({});
  expect(h.command({ type: "thread.interrupt", threadId: id, cascade: true }).ok).toBe(true);
  await h.engine.flush();
  expect(taskStatuses(h, id)).toEqual(["running"]);

  const engine = await restart(h);
  expect(taskStatuses(h, id)).toEqual(["unknown"]);
  expect(engine.queue(id)).toMatchObject({ paused: true, reason: "stopped", messages: [] });
  expect(h.store.getThread(id)?.queue?.pendingCount).toBe(0);
  expect(h.store.getThread(id)?.status.state).toBe("done");
});

test("after a restart, a restart continuation captured behind a Stop no longer keeps the thread waiting", async () => {
  const { h, id } = await waitingOnShell({});
  expect(h.command({ type: "thread.interrupt", threadId: id, cascade: true }).ok).toBe(true);
  await h.engine.flush();
  await h.engine.close();
  // What earlier builds persisted at shutdown: a "continue" held behind the Stop.
  h.store.atomic((db) =>
    db
      .prepare(
        "UPDATE engine_queue SET continuation='continue', trigger='restart' WHERE thread_id=?",
      )
      .run(id),
  );

  const engine = await restart(h);
  expect(engine.queue(id)).toMatchObject({ paused: true, reason: "stopped" });
  expect(h.store.getThread(id)?.queue?.pendingCount).toBe(0);
  expect(h.store.getThread(id)?.status.state).toBe("done");
});

test("Stop from the composer settles the thread when a subagent can no longer be stopped on its own", async () => {
  const frames = scriptFrames();
  const h = await fixture(
    [
      {
        on: "send",
        frames: [
          frames.frame(
            start,
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
          ),
        ],
      },
      { on: "interrupt", fail: "Claude child is no longer available for individual stop" },
      { on: "interrupt" },
    ],
    frames,
  );
  const id = await h.create();
  // The run the composer's Stop names.
  const runId = h.store.getThread(id)?.live?.rootRunId ?? undefined;
  expect(runId).toBeDefined();
  expect(h.command({ type: "thread.interrupt", threadId: id, cascade: true, runId }).ok).toBe(true);
  await h.engine.flush();
  expect(h.adapter.commands.map((command) => command.type)).toEqual([
    "send",
    "interrupt",
    "interrupt",
    "close",
  ]);
  expect(h.adapter.commands[2]).toEqual({ type: "interrupt", target: { cascade: true } });
  expect(h.store.getThread(id)?.status.state).toBe("done");
  const notices = Object.values(h.store.snapshotThread(id).items).filter(
    (item) => item.type === "notice" && item.level === "error",
  );
  expect(notices).toEqual([]);
});

/** A thread whose turn ended leaving `work` that the provider says it can't stop. */
async function leftRunning(work: Fact, next: Fact[] = []) {
  const frames = scriptFrames();
  const h = await fixture(
    [
      { on: "send", frames: [frames.frame(start, work, end)] },
      { on: "interrupt", frames: [] },
      { on: "send", frames: [frames.frame(...next)] },
    ],
    frames,
  );
  const id = await h.create();
  expect(h.command({ type: "thread.interrupt", threadId: id, cascade: true }).ok).toBe(true);
  await h.engine.flush();
  return { h, id };
}
const pastGrace = async (h: Awaited<ReturnType<typeof fixture>>) => {
  h.clock.advance(h.clock.now() + INTERRUPT_GRACE_MS);
  await h.engine.flush();
};

test("a message the provider takes within a Stop's grace isn't cut off by the Stop", async () => {
  // Work that keeps prompts out, from a provider that still takes this one and starts its turn.
  const shell: Fact = {
    type: "background.started",
    agent: "root",
    task: "shell",
    kind: "shell",
    title: "Background build",
    stoppable: false,
    blocksPrompts: true,
  };
  const { h, id } = await leftRunning(shell, [start]);
  expect(
    h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "go on" }] }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.store.getThread(id)?.status.state).toBe("working");
  await pastGrace(h);
  expect(h.adapter.commands.map((command) => command.type)).toEqual(["send", "interrupt", "send"]);
  expect(h.store.getThread(id)?.status.state).toBe("working");
});

test("Claude's placeholder for an unbound subagent never closes a stopped thread's session", async () => {
  // Unstoppable, but it ends by itself and keeps no prompt out.
  const placeholder: Fact = {
    type: "background.started",
    agent: "root",
    task: "unbound",
    kind: "subagent",
    title: "Subagent",
    stoppable: false,
  };
  const { h } = await leftRunning(placeholder);
  await pastGrace(h);
  expect(h.adapter.commands.map((command) => command.type)).toEqual(["send", "interrupt"]);
});
