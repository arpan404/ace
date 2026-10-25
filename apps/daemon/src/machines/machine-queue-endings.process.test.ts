import { expect, it, vi } from "vitest";
import { z } from "zod";
import { Command, ThreadId, WaitResult, type AgentControlOperation } from "@ace/protocol";
import { commandContext } from "../commands.ts";
import { ThreadLifecycle } from "../thread-lifecycle.ts";
import { organizeThread } from "../thread-organization.ts";
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

/** Each way the person on that machine can end a thread, as the app sends it there. */
const endings: Record<string, (pair: Pair, threadId: ThreadId) => Promise<boolean>> = {
  async stop(pair, threadId) {
    return engineCommand(pair, { type: "thread.interrupt", threadId });
  },
  async archive(pair, threadId) {
    return engineCommand(pair, { type: "thread.archive", threadId });
  },
  async settle(pair, threadId) {
    const { store } = pair.target.daemon;
    const command = Command.parse({
      id: `person-settle-${threadId}`,
      deviceId: "person",
      payload: { type: "thread.settle", threadId },
    });
    return store.recordCommand(command.id, command.deviceId, () =>
      organizeThread(store, command, pair.target.h.clock.now()),
    ).ok;
  },
  async delete(pair, threadId) {
    const engine = pair.target.daemon.engine;
    if (!engine) throw new Error("Engine unavailable");
    const lifecycle = new ThreadLifecycle({
      store: pair.target.daemon.store,
      engine,
      handler: engine.handler,
      port: 0,
      hostId: "test",
      token: "unused",
      now: pair.target.h.clock.now,
    });
    const command = Command.parse({
      id: `person-delete-${threadId}`,
      deviceId: "person",
      payload: { type: "thread.delete", threadId },
    });
    return (await lifecycle.delete(command)).ok;
  },
};
function engineCommand(pair: Pair, payload: unknown): boolean {
  const engine = pair.target.daemon.engine;
  if (!engine) throw new Error("Engine unavailable");
  const command = Command.parse({
    id: `person-${JSON.stringify(payload)}`,
    deviceId: "person",
    payload,
  });
  return pair.target.daemon.store.recordCommand(command.id, command.deviceId, () =>
    engine.handler.handle(command, commandContext(pair.target.daemon.store)),
  ).ok;
}

it("a waiting task ended there by Stop, Settle, archive or delete never runs, and its parent hears it ended", async () => {
  const pair = await pairedMachines({ access: "operate" });
  await pair.target.daemon.settings.set("agents.maxRunningChildren", 1, { kind: "global" });
  await pair.source.call({ op: "machines" });
  const delegate = async (name: string) =>
    Delegated.parse((await pair.source.call(task(name))).data).threadId;
  const holder = await delegate("holder");
  const waiting = new Map<string, ThreadId>();
  for (const name of Object.keys(endings)) waiting.set(name, await delegate(`ended-by-${name}`));

  for (const [name, end] of Object.entries(endings)) {
    const threadId = waiting.get(name);
    if (!threadId) throw new Error("Missing child");
    expect(await end(pair, threadId), name).toBe(true);
    // Cancelled with the ending itself: nothing is left waiting to start.
    expect(pair.target.daemon.store.getThread(threadId)?.queuedLaunch, name).toBeUndefined();
    const waited = await pair.source.call({
      op: "wait",
      threadIds: [threadId],
      mode: "all",
      timeoutSeconds: 60,
    });
    expect(WaitResult.parse(waited.data).threads[0]?.state, name).toBe("cancelled");
  }

  // The slot frees; none of the ended tasks starts.
  await pair.finishTask(holder, "Do the holder part", "Held the slot.");
  await pair.target.daemon.engine?.flush();
  for (const [name, threadId] of waiting)
    expect(pair.target.h.inputs.get(threadId) ?? [], name).toEqual([]);
}, 90_000);
