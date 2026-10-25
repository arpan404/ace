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
import { machineRequest, type MachineTransport } from "./transport.ts";

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
async function limitedPair(options: Parameters<typeof pairedMachines>[0] = {}) {
  const pair = await pairedMachines({ access: "operate", ...options });
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
  // Here it reads as queued, never done.
  expect(await stateHere(second)).toMatchObject({ state: "queued", machine: "Studio" });
  await vi.waitFor(async () => expect((await stateHere(first))?.state).toBe("working"), {
    timeout: 15_000,
  });

  await pair.finishTask(first, "Do the first part", "First part done.");
  await vi.waitFor(() => expect(pair.target.h.contexts.get(second)).toBeDefined(), {
    timeout: 15_000,
  });
  expect(pair.target.daemon.store.getThread(second)?.queuedLaunch).toBeUndefined();
  await vi.waitFor(async () => expect((await stateHere(second))?.state).toBe("working"), {
    timeout: 15_000,
  });

  await pair.finishTask(second, "Do the second part", "Second part done.");
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
  await pair.finishTask(first, "Do the holder part", "Holder done.");
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
  await vi.waitFor(() => expect(pair.target.h.contexts.get(first)).toBeDefined(), {
    timeout: 15_000,
  });
  // The person turns the provider off on that machine while the task waits.
  await pair.target.daemon.settings.set(
    "providers.configuration",
    [{ provider: "claude", enabled: false }],
    { kind: "global" },
  );
  await pair.finishTask(
    first,
    "Do the before-disable part",
    "Done before the provider was turned off.",
  );

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
  let statusCalls = 0;
  const counted: MachineTransport = async (profile, body, options) => {
    const answer = await machineRequest(profile, body, options);
    if (body.call.op === "status") statusCalls++;
    return answer;
  };
  const { pair, delegate, stateHere } = await limitedPair({ sourceTransport: counted });
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
  await vi.waitFor(() => expect(pair.target.h.contexts.get(reopened)).toBeDefined(), {
    timeout: 15_000,
  });
  // A whole poll after the new work started never brings back the old cancellation.
  const after = statusCalls;
  await vi.waitFor(() => expect(statusCalls).toBeGreaterThan(after + 1), { timeout: 15_000 });
  expect((await stateHere(reopened))?.state).toBe("working");

  await pair.finishTask(first, "Do the busy part", "Busy part done.");
  await pair.finishTask(reopened, "Do this instead", "Did it instead.");
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
  // The queue drains as the holder's status changes, before finishTask sees it done.
  await pair.finishTask(first, "Do the running-there part", "Done there.");
  await pair.target.daemon.engine?.flush();
  expect(pair.target.h.contexts.get(queued)).toBeUndefined();
  expect(pair.target.h.inputs.get(queued) ?? []).toEqual([]);
}, 60_000);

it("children that already finished there never hold a slot, and raising the limit there starts a waiting one", async () => {
  const { pair, delegate, stateHere } = await limitedPair();
  for (const name of ["earlier-a", "earlier-b"]) {
    const done = await delegate(name);
    await pair.finishTask(done, `Do the ${name} part`, `${name} done.`);
  }
  const running = await delegate("running-now");
  expect(pair.target.daemon.store.getThread(running)?.queuedLaunch).toBeUndefined();
  const waiting = await delegate("waiting-now");
  expect(await stateHere(waiting)).toMatchObject({ state: "queued" });

  // Nothing finishes: the raised limit alone starts it.
  await pair.target.daemon.settings.set("agents.maxRunningChildren", 2, { kind: "global" });
  await vi.waitFor(() => expect(pair.target.h.contexts.get(waiting)).toBeDefined(), {
    timeout: 15_000,
  });
  expect(pair.target.daemon.store.getThread(waiting)?.queuedLaunch).toBeUndefined();
}, 60_000);

it("a waiting task that can no longer start there does not hold back the task queued behind it", async () => {
  const { pair, delegate } = await limitedPair();
  const first = await delegate("ahead-running");
  const unlaunchable = await delegate("ahead-refused");
  const behind = Delegated.parse(
    (await pair.source.call({ ...task("behind-launchable"), provider: "codex" })).data,
  ).threadId;
  await vi.waitFor(() => expect(pair.target.h.contexts.get(first)).toBeDefined(), {
    timeout: 15_000,
  });
  // Claude is turned off there: the task first in line can never start, the one behind it can.
  await pair.target.daemon.settings.set(
    "providers.configuration",
    [{ provider: "claude", enabled: false }],
    { kind: "global" },
  );
  await pair.finishTask(first, "Do the ahead-running part", "Done ahead.");

  expect(
    WaitResult.parse(
      (
        await pair.source.call({
          op: "wait",
          threadIds: [unlaunchable],
          mode: "all",
          timeoutSeconds: 60,
        })
      ).data,
    ).threads[0],
  ).toMatchObject({ state: "failed", result: "It could not be started." });
  // The slot the refused task never used goes to the next one in line, with nothing else freeing.
  await vi.waitFor(
    () =>
      expect((pair.target.h.inputs.get(behind) ?? []).join("\n")).toContain(
        "Do the behind-launchable part",
      ),
    { timeout: 15_000 },
  );
}, 60_000);

it("a stopped task's cancellation read before new work lands never settles it once that work runs", async () => {
  // The source's status calls go through the real transport; one chosen reply can be held.
  let hold: ((answer: unknown) => Promise<unknown>) | undefined;
  let statusCalls = 0;
  const transport: MachineTransport = async (profile, body, options) => {
    const answer = await machineRequest(profile, body, options);
    if (body.call.op !== "status") return answer;
    statusCalls++;
    return hold ? hold(answer) : answer;
  };
  const { pair, delegate, stateHere } = await limitedPair({ sourceTransport: transport });
  const first = await delegate("keeps-slot");
  const reopened = await delegate("stopped-then-reworked");

  // The next status reply that reads its cancellation is held back, as a slow network would.
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolveHeld) => {
    hold = (answer) => {
      if (!JSON.stringify(answer).includes("Stopped before it started."))
        return Promise.resolve(answer);
      hold = undefined;
      resolveHeld();
      return new Promise((resolveReply) => {
        release = () => resolveReply(answer);
      });
    };
  });
  expect(
    (await pair.source.call({ op: "agent.cancel", threadId: reopened, requestId: "stop-it" })).ok,
  ).toBe(true);
  await held;

  // New work goes in while that old reply is still on its way.
  const sent = await pair.source.call({
    op: "thread.message",
    threadId: reopened,
    requestId: "new-work-while-held",
    text: "Do this after all",
  });
  expect(sent.ok).toBe(true);
  release?.();
  // A later poll proves the held one was handled; the child still reads working.
  const after = statusCalls;
  await vi.waitFor(() => expect(statusCalls).toBeGreaterThan(after + 1), { timeout: 15_000 });
  expect(await stateHere(reopened)).not.toMatchObject({ state: "cancelled" });

  await pair.finishTask(first, "Do the keeps-slot part", "Kept the slot.");
  await pair.finishTask(reopened, "Do this after all", "Did it after all.");
  const waited = await pair.source.call({
    op: "wait",
    threadIds: [reopened],
    mode: "all",
    timeoutSeconds: 60,
  });
  expect(WaitResult.parse(waited.data).threads[0]).toMatchObject({
    state: "done",
    result: "Did it after all.",
  });
  // The parent was never handed the stale cancellation as this child's result.
  expect((pair.source.h.inputs.get(pair.source.caller.threadId) ?? []).join("\n")).not.toContain(
    "Stopped before it started.",
  );
}, 60_000);
