import { expect, it, vi } from "vitest";
import { z } from "zod";
import { MonitorSnapshot, ThreadId, WaitResult, type AgentControlOperation } from "@ace/protocol";
import { pairedMachines } from "./machine-test-support.ts";
import { machineRequest, type MachineTransport } from "./transport.ts";

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
const waitFor = async (pair: Pair, id: ThreadId) =>
  WaitResult.parse(
    (await pair.source.call({ op: "wait", threadIds: [id], mode: "all", timeoutSeconds: 60 })).data,
  ).threads[0];

it("a finished remote child given new work stays open through a caller restart before the reply, and reports its new result", async () => {
  // The next message is taken by the target, but its reply never reaches the caller.
  let holdNextMessage = false;
  let accepted = () => {};
  const taken = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const transport: MachineTransport = async (profile, body, options) => {
    const answer = await machineRequest(profile, body, options);
    if (body.call.op !== "message" || !holdNextMessage) return answer;
    holdNextMessage = false;
    accepted();
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
