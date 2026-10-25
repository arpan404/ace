import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { MonitorSnapshot, ThreadId, WaitResult, type AgentControlOperation } from "@ace/protocol";
import { pairedMachines } from "./machine-test-support.ts";

type Pair = Awaited<ReturnType<typeof pairedMachines>>;
const Delegated = z.object({ threadId: ThreadId });
const task = (name: string) =>
  ({
    op: "delegate_task",
    requestId: `${name}-on-studio`,
    task: `Do the ${name} part`,
    role: `Do-${name}-part`,
    provider: "claude",
    machine: "studio",
    project: "project",
  }) satisfies AgentControlOperation;
const delegate = async (pair: Pair, name: string) =>
  Delegated.parse((await pair.source.call(task(name))).data).threadId;
const stateHere = async (pair: Pair, id: ThreadId) =>
  MonitorSnapshot.parse((await pair.source.call({ op: "agents.status" })).data).children.find(
    (child) => child.id === id,
  )?.state;
const waitFor = async (pair: Pair, id: ThreadId) =>
  WaitResult.parse(
    (await pair.source.call({ op: "wait", threadIds: [id], mode: "all", timeoutSeconds: 60 })).data,
  ).threads[0];
/** The source parent's own agent ends its turn, as a provider reports it. */
async function endParentTurn(pair: Pair, text: string) {
  const { source } = pair;
  const context = source.h.contexts.get(source.caller.threadId);
  if (!context) throw new Error("Parent session not open");
  context.onFrame(
    source.h.frames.frame(
      {
        type: "item.upsert",
        agent: "root",
        item: randomUUID(),
        draft: {
          type: "message",
          role: "assistant",
          parts: [{ type: "text", text }],
          complete: true,
        },
      },
      { type: "turn.ended", agent: "root", outcome: "completed" },
    ),
  );
  await source.daemon.engine?.flush();
}

it("a parent whose own turn ends while its only child waits on a full machine stays waiting, and hears the result", async () => {
  // The target's one engine slot is held by its own working thread.
  const pair = await pairedMachines({
    access: "operate",
    targetEngineLimits: { maxActiveThreads: 1 },
  });
  await pair.source.call({ op: "machines" });
  // Someone on that machine is running a Claude thread, which takes its one engine slot.
  const busy = pair.target.controls.delegations.command("busy-there", {
    type: "thread.create",
    workspaceId: pair.target.workspace,
    provider: "claude",
    input: [{ type: "text", text: "Long local work" }],
  });
  if (!busy.ok || !busy.threadId) throw new Error("Busy thread not started");
  const busyThread = busy.threadId;
  // Mid-turn, so its slot can't be reclaimed for the child.
  await vi.waitFor(
    () =>
      expect((pair.target.h.inputs.get(busyThread) ?? []).join("\n")).toContain("Long local work"),
    { timeout: 15_000 },
  );
  const child = await delegate(pair, "on-full-machine");
  expect(pair.target.daemon.store.getThread(child)?.queuedLaunch).toBeDefined();
  expect(pair.target.h.contexts.get(child)).toBeUndefined();

  // Nothing else of the parent's runs: its only child is queued, and its own turn ends.
  await endParentTurn(pair, "Waiting on the other machine.");
  expect(await stateHere(pair, child)).toBe("queued");
  // Its own agent is idle, yet it waits on the queued child instead of reading done.
  expect(pair.source.daemon.store.getThread(pair.source.caller.threadId)?.status).toMatchObject({
    state: "waiting",
  });

  // The machine's own work finishes, its engine slot frees, and the child starts there.
  await pair.finishTask(busyThread, "Long local work", "Done with my own work.");
  await vi.waitFor(() => expect(pair.target.h.contexts.get(child)).toBeDefined(), {
    timeout: 15_000,
  });
  await pair.finishTask(child, "Do the on-full-machine part", "Finished on the full machine.");
  expect(await waitFor(pair, child)).toMatchObject({
    state: "done",
    result: "Finished on the full machine.",
  });
}, 60_000);

it("waiting tasks survive a restart of the other machine: they start when a slot frees, a retried request is the same child, and cancelling still works", async () => {
  const pair = await pairedMachines({ access: "operate" });
  await pair.target.daemon.settings.set("agents.maxRunningChildren", 1, { kind: "global" });
  await pair.source.call({ op: "machines" });
  const running = await delegate(pair, "running");
  const waiting = await delegate(pair, "waiting");
  const cancelled = await delegate(pair, "cancelled-later");
  expect(await stateHere(pair, waiting)).toBe("queued");

  await pair.restartTarget();
  expect(pair.target.daemon.store.getThread(waiting)?.queuedLaunch?.text).toBe(
    "Do the waiting part",
  );
  await vi.waitFor(async () => expect(await stateHere(pair, waiting)).toBe("queued"), {
    timeout: 15_000,
  });

  // A retry whose first reply was lost reaches the target again: the source forgets it sent
  // the request, and the target answers with the same queued child instead of a second one.
  pair.source.daemon.store.statement("DELETE FROM machine_children WHERE id=?").run(waiting);
  expect(await delegate(pair, "waiting")).toBe(waiting);
  expect(
    pair.target.daemon.store.listThreads().filter((thread) => thread.title === "Do-waiting-part"),
  ).toHaveLength(1);
  expect(await stateHere(pair, waiting)).toBe("queued");

  // Cancelling a waiting child after the restart settles it without running.
  const stop = await pair.source.call({
    op: "agent.cancel",
    threadId: cancelled,
    requestId: "stop-after-restart",
  });
  expect(stop.ok).toBe(true);
  expect(await waitFor(pair, cancelled)).toMatchObject({
    state: "cancelled",
    result: "Stopped before it started.",
  });

  // The running child stops, its slot frees, and the waiting one starts; the cancelled never does.
  const freed = await pair.source.call({
    op: "agent.cancel",
    threadId: running,
    requestId: "stop-running",
  });
  expect(freed.ok).toBe(true);
  await vi.waitFor(
    () =>
      expect((pair.target.h.inputs.get(waiting) ?? []).join("\n")).toContain("Do the waiting part"),
    { timeout: 15_000 },
  );
  await pair.finishTask(waiting, "Do the waiting part", "Waited through a restart.");
  expect(await waitFor(pair, waiting)).toMatchObject({
    state: "done",
    result: "Waited through a restart.",
  });
  expect(pair.target.h.inputs.get(cancelled) ?? []).toEqual([]);
}, 90_000);
