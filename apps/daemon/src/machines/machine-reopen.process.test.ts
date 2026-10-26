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
import { MachineFailure, machineRequest, type MachineTransport } from "./transport.ts";

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
const stateHere = async (pair: Pair, id: ThreadId) =>
  MonitorSnapshot.parse((await pair.source.call({ op: "agents.status" })).data).children.find(
    (child) => child.id === id,
  )?.state;
/** Time passes on the caller past the longest wait before a message is retried. */
const retriesDue = (pair: Pair) => pair.source.h.clock.advance(pair.source.h.clock.now() + 60_000);
const waitFor = async (pair: Pair, id: ThreadId) =>
  WaitResult.parse(
    (await pair.source.call({ op: "wait", threadIds: [id], mode: "all", timeoutSeconds: 60 })).data,
  ).threads[0];

it("a finished remote child given new work stays open through a caller restart before the reply, and reports its new result", async () => {
  // The next message is taken by the target, but its reply never reaches the caller.
  let holdNextMessage = false;
  let accepted: (() => void) | undefined;
  const taken = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const transport: MachineTransport = async (profile, body, options) => {
    const answer = await machineRequest(profile, body, options);
    if (body.call.op !== "message" || !holdNextMessage) return answer;
    holdNextMessage = false;
    accepted?.();
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  };
  const pair = await pairedMachines({ access: "operate", sourceTransport: transport });
  await pair.source.call({ op: "machines" });
  const child = Delegated.parse((await pair.source.call(task("first-pass"))).data).threadId;
  await pair.finishTask(child, "Do the first-pass part", "First pass done.");
  expect(await waitFor(pair, child)).toMatchObject({ state: "done", result: "First pass done." });

  holdNextMessage = true;
  void pair.source
    .call({
      op: "thread.message",
      threadId: child,
      requestId: "second-pass",
      text: "Do a second pass",
    })
    .catch(() => undefined);
  await taken;
  await vi.waitFor(
    () => expect((pair.target.h.inputs.get(child) ?? []).join("\n")).toContain("Do a second pass"),
    { timeout: 15_000 },
  );

  // The caller stops before it hears back, then starts again.
  await pair.restartSource();
  expect(await stateHere(pair, child)).toBe("working");
  expect(pair.source.daemon.store.getThread(pair.source.caller.threadId)?.status.state).not.toBe(
    "done",
  );

  await pair.finishTask(child, "Do a second pass", "Second pass done.");
  await vi.waitFor(
    async () =>
      expect(await waitFor(pair, child)).toMatchObject({
        state: "done",
        result: "Second pass done.",
      }),
    { timeout: 15_000 },
  );
}, 90_000);

it("a remote child stopped while waiting and then given work by the person on its machine reads running again here, then reports its result", async () => {
  const pair = await pairedMachines({ access: "operate" });
  await pair.target.daemon.settings.set("agents.maxRunningChildren", 1, { kind: "global" });
  await pair.source.call({ op: "machines" });
  const holder = Delegated.parse((await pair.source.call(task("holder"))).data).threadId;
  const child = Delegated.parse((await pair.source.call(task("stopped-here"))).data).threadId;
  expect(
    (await pair.source.call({ op: "agent.cancel", threadId: child, requestId: "stop-it" })).ok,
  ).toBe(true);
  expect(await waitFor(pair, child)).toMatchObject({
    state: "cancelled",
    result: "Stopped before it started.",
  });

  // The person on that machine opens the stopped thread and gives it work there.
  const engine = pair.target.daemon.engine;
  if (!engine) throw new Error("Engine unavailable");
  const send = Command.parse({
    id: "person-works-there",
    deviceId: "person",
    payload: {
      type: "thread.send",
      threadId: child,
      input: [{ type: "text", text: "Fix it here instead" }],
      trigger: "user",
    },
  });
  expect(
    pair.target.daemon.store.recordCommand(send.id, send.deviceId, () =>
      engine.handler.handle(send, commandContext(pair.target.daemon.store)),
    ).ok,
  ).toBe(true);

  // Here it reads running again, and its parent waits for it.
  await vi.waitFor(async () => expect(await stateHere(pair, child)).toBe("working"), {
    timeout: 15_000,
  });
  expect(pair.source.daemon.store.getThread(pair.source.caller.threadId)?.status.state).not.toBe(
    "done",
  );

  await pair.finishTask(holder, "Do the holder part", "Held the slot.");
  await pair.finishTask(child, "Fix it here instead", "Fixed it on that machine.");
  await vi.waitFor(
    async () =>
      expect(await waitFor(pair, child)).toMatchObject({
        state: "done",
        result: "Fixed it on that machine.",
      }),
    { timeout: 15_000 },
  );
}, 90_000);

/**
 * The source's calls to the target, where message requests can be held before they reach it, as
 * a request waiting in the target's access check is from the caller's side. `failCaller` makes
 * the caller hear a dropped connection while its request is still on its way.
 */
function gatedTransport() {
  const gate = { closed: false, failCaller: false, onlyFirst: false, release: () => {} };
  let opened = Promise.resolve();
  let arrived: Promise<void> = Promise.resolve();
  let held = 0;
  let statusCalls = 0;
  const transport: MachineTransport = async (profile, body, options) => {
    if (body.call.op === "status") statusCalls++;
    if (body.call.op !== "message" || !gate.closed || (gate.onlyFirst && held > 0))
      return machineRequest(profile, body, options);
    held++;
    const arrives = opened.then(() => machineRequest(profile, body, options));
    arrived = arrives.then(
      () => undefined,
      () => undefined,
    );
    if (!gate.failCaller) return arrives;
    arrives.catch(() => undefined);
    throw new MachineFailure("disconnected");
  };
  return {
    transport,
    gate,
    held: () => held,
    /** Settles once the held copies have reached the target and it answered. */
    arrived: () => arrived,
    statusCalls: () => statusCalls,
    close() {
      gate.closed = true;
      opened = new Promise((resolve) => {
        gate.release = () => resolve();
      });
    },
    open() {
      gate.closed = false;
      gate.release();
    },
  };
}

/**
 * A child that finished, then a follow-up held on its way. While the target still reports the
 * old result, at least two whole polls pass and the child never reads done; then the request
 * lands and the child reports its real new result, the message having run once.
 */
async function heldFollowUp(stopBetween: (pair: Pair) => Promise<void>, failCaller: boolean) {
  const gated = gatedTransport();
  const pair = await pairedMachines({ access: "operate", sourceTransport: gated.transport });
  await pair.source.call({ op: "machines" });
  const child = Delegated.parse((await pair.source.call(task("first-pass"))).data).threadId;
  await pair.finishTask(child, "Do the first-pass part", "First pass done.");
  expect(await waitFor(pair, child)).toMatchObject({ state: "done", result: "First pass done." });

  gated.gate.failCaller = failCaller;
  gated.close();
  void pair.source
    .call({ op: "thread.message", threadId: child, requestId: "second", text: "Do a second pass" })
    .catch(() => undefined);
  await vi.waitFor(() => expect(gated.held()).toBeGreaterThan(0), { timeout: 15_000 });
  await stopBetween(pair);

  const after = gated.statusCalls();
  await vi.waitFor(() => expect(gated.statusCalls()).toBeGreaterThan(after + 1), {
    timeout: 15_000,
  });
  expect(await stateHere(pair, child)).toBe("working");
  expect(pair.source.daemon.store.getThread(pair.source.caller.threadId)?.status.state).not.toBe(
    "done",
  );

  gated.open();
  retriesDue(pair);
  await pair.finishTask(child, "Do a second pass", "Second pass done.");
  await vi.waitFor(
    async () =>
      expect(await waitFor(pair, child)).toMatchObject({
        state: "done",
        result: "Second pass done.",
      }),
    { timeout: 15_000 },
  );
  expect(
    (pair.target.h.inputs.get(child) ?? []).filter((text) => text === "Do a second pass"),
  ).toHaveLength(1);
}

it("a follow-up still on its way when the caller restarts never lets the child read done before its new result", async () => {
  await heldFollowUp((pair) => pair.restartSource(), false);
}, 120_000);

it("a follow-up whose call timed out while it was still on its way never lets the child read done before its new result", async () => {
  await heldFollowUp(async () => {}, true);
}, 120_000);

/**
 * A child that finished, then a follow-up whose first copy is held on its way to the target while
 * the caller hears its call dropped; later copies (the caller's retries) go straight through.
 */
async function droppedFollowUp(before: (pair: Pair) => Promise<void>) {
  const gated = gatedTransport();
  const pair = await pairedMachines({ access: "operate", sourceTransport: gated.transport });
  await pair.source.call({ op: "machines" });
  const child = Delegated.parse((await pair.source.call(task("first-pass"))).data).threadId;
  await pair.finishTask(child, "Do the first-pass part", "First pass done.");
  expect(await waitFor(pair, child)).toMatchObject({ state: "done", result: "First pass done." });
  await before(pair);
  gated.gate.failCaller = true;
  gated.gate.onlyFirst = true;
  gated.close();
  void pair.source
    .call({ op: "thread.message", threadId: child, requestId: "second", text: "Do a second pass" })
    .catch(() => undefined);
  await vi.waitFor(() => expect(gated.held()).toBe(1), { timeout: 15_000 });
  return { pair, gated, child };
}

it("a retry refused only at the target's access check never lets the child read done before the delayed original runs", async () => {
  // Agents from the caller may only read there for now: its retries are refused at the access
  // check, which says nothing about the copy still on its way.
  const { pair, gated, child } = await droppedFollowUp((paired) => paired.access("read"));
  const after = gated.statusCalls();
  await vi.waitFor(() => expect(gated.statusCalls()).toBeGreaterThan(after + 1), {
    timeout: 15_000,
  });
  expect(await stateHere(pair, child)).toBe("working");
  expect(pair.source.daemon.store.getThread(pair.source.caller.threadId)?.status.state).not.toBe(
    "done",
  );

  // Agents may act there again, and the delayed original lands and runs.
  await pair.access("operate");
  gated.open();
  await gated.arrived();
  retriesDue(pair);
  await pair.finishTask(child, "Do a second pass", "Second pass done.");
  await vi.waitFor(
    async () =>
      expect(await waitFor(pair, child)).toMatchObject({
        state: "done",
        result: "Second pass done.",
      }),
    { timeout: 15_000 },
  );
  expect(
    (pair.target.h.inputs.get(child) ?? []).filter((text) => text === "Do a second pass"),
  ).toHaveLength(1);
}, 120_000);

it("a message the target refused for that request never runs, not even a copy that was still on its way", async () => {
  // Its provider is off there: a retry reaches the message itself and is refused, an answer
  // recorded for this request, so the child settles back to the result its parent already has.
  const { pair, gated, child } = await droppedFollowUp((paired) =>
    paired.target.daemon.settings.set(
      "providers.configuration",
      [{ provider: "claude", enabled: false }],
      { kind: "global" },
    ),
  );
  await vi.waitFor(async () => expect(await stateHere(pair, child)).toBe("done"), {
    timeout: 15_000,
  });

  // The provider comes back and the delayed copy lands: it is refused like its retry.
  await pair.target.daemon.settings.set("providers.configuration", [], { kind: "global" });
  gated.open();
  await gated.arrived();
  await pair.target.daemon.engine?.flush();
  expect(pair.target.h.inputs.get(child) ?? []).not.toContain("Do a second pass");
  expect(await stateHere(pair, child)).toBe("done");
}, 120_000);
