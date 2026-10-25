import { expect, it, vi } from "vitest";
import { z } from "zod";
import { MonitorSnapshot, ThreadId, WaitResult, type AgentControlOperation } from "@ace/protocol";
import { pairedMachines } from "./machine-test-support.ts";

const Delegated = z.object({ threadId: ThreadId });
const task = (name: string, project = "project") =>
  ({
    op: "delegate_task",
    requestId: `${name}-on-studio`,
    task: `Do the ${name} part`,
    role: `Do-${name}-part`,
    provider: "claude",
    machine: "studio",
    project,
  }) satisfies AgentControlOperation;

/** Two paired daemons where the target runs one child per calling thread at a time. */
async function limitedPair() {
  const pair = await pairedMachines({ access: "operate" });
  await pair.target.daemon.settings.set("agents.maxRunningChildren", 1, { kind: "global" });
  await pair.source.call({ op: "machines" });
  const delegate = async (name: string) =>
    Delegated.parse((await pair.source.call(task(name))).data).threadId;
  const stateHere = async (id: ThreadId) =>
    MonitorSnapshot.parse((await pair.source.call({ op: "agents.status" })).data).children.find(
      (child) => child.id === id,
    );
  return { pair, delegate, stateHere };
}

it("a task sent to a machine at its running limit waits there, reads as queued here, and starts when a slot frees", async () => {
  const { pair, delegate, stateHere } = await limitedPair();
  const first = await delegate("first");
  const second = await delegate("second");

  // It waits on the other machine with its task shown, and nothing runs it yet.
  expect(pair.target.daemon.store.getThread(second)?.queuedLaunch?.text).toBe("Do the second part");
  expect(pair.target.h.contexts.get(second)).toBeUndefined();
  // Here it reads as queued, never done, and keeps its parent open.
  expect(await stateHere(second)).toMatchObject({ state: "queued", machine: "Studio" });
  await vi.waitFor(async () => expect((await stateHere(first))?.state).toBe("working"));
  expect(pair.source.daemon.store.getThread(pair.source.caller.threadId)?.status.state).not.toBe(
    "done",
  );

  await pair.finish(first, "First part done.");
  await vi.waitFor(() => expect(pair.target.h.contexts.get(second)).toBeDefined());
  expect(pair.target.daemon.store.getThread(second)?.queuedLaunch).toBeUndefined();
  await vi.waitFor(async () => expect((await stateHere(second))?.state).toBe("working"));

  await pair.finish(second, "Second part done.");
  const waited = await pair.source.call({
    op: "wait",
    threadIds: [second],
    mode: "all",
    timeoutSeconds: 60,
  });
  expect(WaitResult.parse(waited.data).threads[0]).toMatchObject({
    state: "done",
    result: "Second part done.",
  });
}, 60_000);

it("a task waiting on another machine can be stopped before it starts, and its parent hears so", async () => {
  const { pair, delegate } = await limitedPair();
  const first = await delegate("holder");
  const queued = await delegate("stopped");
  const cancelled = await pair.source.call({
    op: "agent.cancel",
    threadId: queued,
    requestId: "stop-queued",
  });
  expect(cancelled.ok).toBe(true);

  const waited = await pair.source.call({
    op: "wait",
    threadIds: [queued],
    mode: "all",
    timeoutSeconds: 60,
  });
  expect(WaitResult.parse(waited.data).threads[0]).toMatchObject({
    state: "cancelled",
    result: "Stopped before it started.",
  });
  // A freed slot never starts it afterwards.
  await pair.finish(first, "Holder done.");
  await pair.target.daemon.engine?.flush();
  expect(pair.target.h.contexts.get(queued)).toBeUndefined();
  expect(pair.target.daemon.store.getThread(queued)?.queuedLaunch).toBeUndefined();
}, 60_000);

it("a task the other machine can never run is still refused at once, leaving nothing there", async () => {
  const { pair } = await limitedPair();
  await expect(pair.source.call(task("missing", "no-such-project"))).rejects.toMatchObject({
    detail: expect.stringContaining("no-such-project"),
  });
  await expect(
    pair.source.call({ ...task("uninstalled"), provider: "opencode" }),
  ).rejects.toMatchObject({ detail: expect.stringContaining("could not start it") });
  const titles = pair.target.daemon.store.listThreads().map((thread) => thread.title);
  expect(titles).not.toContain("Do-missing-part");
  expect(titles).not.toContain("Do-uninstalled-part");
}, 60_000);
