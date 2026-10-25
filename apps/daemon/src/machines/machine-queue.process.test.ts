import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  Command,
  MonitorSnapshot,
  ThreadId,
  WaitResult,
  type AgentControlOperation,
} from "@ace/protocol";
import { commandContext } from "../commands.ts";
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

it("a waiting task whose start is later refused there settles failed instead of staying queued", async () => {
  const { pair, delegate } = await limitedPair();
  const first = await delegate("before-disable");
  const queued = await delegate("refused-later");
  await vi.waitFor(() => expect(pair.target.h.contexts.get(first)).toBeDefined());
  // The person turns the provider off on that machine while the task waits.
  await pair.target.daemon.settings.set(
    "providers.configuration",
    [{ provider: "claude", enabled: false }],
    { kind: "global" },
  );
  await pair.finish(first, "Done before the provider was turned off.");

  const waited = await pair.source.call({
    op: "wait",
    threadIds: [queued],
    mode: "all",
    timeoutSeconds: 60,
  });
  expect(WaitResult.parse(waited.data).threads[0]).toMatchObject({
    state: "failed",
    result: "It could not be started.",
  });
  expect(pair.target.daemon.store.getThread(queued)?.queuedLaunch).toBeUndefined();
  expect(pair.target.h.contexts.get(queued)).toBeUndefined();
}, 60_000);

it("a task stopped while waiting and then given new work reads working until its new result", async () => {
  const { pair, delegate, stateHere } = await limitedPair();
  const first = await delegate("busy");
  const reopened = await delegate("reopened");
  await pair.source.call({ op: "agent.cancel", threadId: reopened, requestId: "stop-reopened" });
  const stopped = await pair.source.call({
    op: "wait",
    threadIds: [reopened],
    mode: "all",
    timeoutSeconds: 60,
  });
  expect(WaitResult.parse(stopped.data).threads[0]?.state).toBe("cancelled");

  const sent = await pair.source.call({
    op: "thread.message",
    threadId: reopened,
    requestId: "new-work",
    text: "Do this instead",
  });
  expect(sent.ok).toBe(true);
  await vi.waitFor(() => expect(pair.target.h.contexts.get(reopened)).toBeDefined());
  // Polls after the new work started never bring back the old cancellation.
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect((await stateHere(reopened))?.state).toBe("working");

  await pair.finish(first, "Busy part done.");
  await pair.finish(reopened, "Did it instead.");
  const waited = await pair.source.call({
    op: "wait",
    threadIds: [reopened],
    mode: "all",
    timeoutSeconds: 60,
  });
  expect(WaitResult.parse(waited.data).threads[0]).toMatchObject({
    state: "done",
    result: "Did it instead.",
  });
}, 60_000);

it("the target's person stopping a waiting task there means it never runs, and the parent hears it stopped", async () => {
  const { pair, delegate } = await limitedPair();
  const first = await delegate("running-there");
  const queued = await delegate("stopped-there");
  // The person on that machine presses Stop on the waiting thread, as its composer does.
  const engine = pair.target.daemon.engine;
  if (!engine) throw new Error("Engine unavailable");
  const stop = Command.parse({
    id: "person-stop-queued",
    deviceId: "person",
    payload: { type: "thread.interrupt", threadId: queued },
  });
  const stopped = pair.target.daemon.store.recordCommand(stop.id, stop.deviceId, () =>
    engine.handler.handle(stop, commandContext(pair.target.daemon.store)),
  );
  expect(stopped.ok).toBe(true);
  expect(pair.target.daemon.store.getThread(queued)?.queuedLaunch).toBeUndefined();

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
  // The slot it waited for frees, and the stopped task still never runs.
  await pair.finish(first, "Done there.");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await pair.target.daemon.engine?.flush();
  expect(pair.target.h.contexts.get(queued)).toBeUndefined();
  expect(pair.target.h.inputs.get(queued) ?? []).toEqual([]);
}, 60_000);

it("children that already finished there never hold a slot, and raising the limit there starts a waiting one", async () => {
  const { pair, delegate, stateHere } = await limitedPair();
  for (const name of ["earlier-a", "earlier-b"]) {
    const done = await delegate(name);
    // Its task reached the provider, so finishing ends that turn.
    await vi.waitFor(() =>
      expect((pair.target.h.inputs.get(done) ?? []).join("\n")).toContain(`Do the ${name} part`),
    );
    await pair.finish(done, `${name} done.`);
    await vi.waitFor(() =>
      expect(pair.target.daemon.store.getThread(done)?.status.state).toBe("done"),
    );
  }
  const running = await delegate("running-now");
  expect(pair.target.daemon.store.getThread(running)?.queuedLaunch).toBeUndefined();
  const waiting = await delegate("waiting-now");
  expect(await stateHere(waiting)).toMatchObject({ state: "queued" });

  // Nothing finishes: the raised limit alone starts it.
  await pair.target.daemon.settings.set("agents.maxRunningChildren", 2, { kind: "global" });
  await vi.waitFor(() => expect(pair.target.h.contexts.get(waiting)).toBeDefined());
  expect(pair.target.daemon.store.getThread(waiting)?.queuedLaunch).toBeUndefined();
}, 60_000);
