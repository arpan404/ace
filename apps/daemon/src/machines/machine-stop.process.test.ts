import { expect, it, vi } from "vitest";
import { z } from "zod";
import { Command, MonitorSnapshot, ThreadId, type AgentControlOperation } from "@ace/protocol";
import { commandContext } from "../commands.ts";
import { pairedMachines } from "./machine-test-support.ts";

/*
 * The live case of 2026-11-01 between two real daemons: a child delegated to a paired machine
 * whose first message was never sent there sits in needs_you ("Not sent · Try again"). Its
 * parent's cancel must end it on both machines, and the parent must stop waiting.
 */

const Delegated = z.object({ threadId: ThreadId });
const delegation = {
  op: "delegate_task",
  requestId: "rereview-on-studio",
  task: "Re-review the fixes",
  role: "Rereview-1564-fixes",
  provider: "codex",
  machine: "studio",
  project: "project",
} satisfies AgentControlOperation;

it("a child on a paired machine whose first message was never sent, held for the person there, ends cancelled on both machines when its parent cancels it", async () => {
  const pair = await pairedMachines({ access: "operate" });
  await pair.source.call({ op: "machines" });
  // The child's first message is refused there, so it is held for the person: Not sent.
  pair.target.h.failNextSend("rejected", "queue");
  pair.target.h.failNextSend("rejected", "steer");
  const { threadId } = Delegated.parse((await pair.source.call(delegation)).data);
  // The person there pauses its queue, so the message waits on them, never sending by itself.
  const engine = pair.target.daemon.engine;
  if (!engine) throw new Error("Engine unavailable");
  await vi.waitFor(() => expect(engine.queue(threadId).messages).toHaveLength(1), {
    timeout: 15_000,
  });
  const pause = Command.parse({
    id: "pause-there",
    deviceId: "person",
    payload: {
      type: "queue.pause",
      threadId,
      expectedRevision: engine.queue(threadId).revision,
    },
  });
  expect(
    pair.target.daemon.store.recordCommand(pause.id, pause.deviceId, () =>
      engine.handler.handle(pause, commandContext(pair.target.daemon.store)),
    ).ok,
  ).toBe(true);
  const status = async () =>
    MonitorSnapshot.parse((await pair.source.call({ op: "agents.status" })).data).children.find(
      (child) => child.id === threadId,
    );
  await vi.waitFor(async () => expect((await status())?.state).toBe("needs_you"), {
    timeout: 15_000,
  });

  const cancelled = await pair.source.call({
    op: "agent.cancel",
    threadId,
    requestId: "stop-rereview",
  });
  expect(cancelled.ok).toBe(true);

  // Its machine confirms: it settles there, so here it ends with no warning.
  await vi.waitFor(async () => expect(["cancelled", "done"]).toContain((await status())?.state), {
    timeout: 15_000,
  });
  expect((await status())?.contact).toBeUndefined();
  const there = pair.target.daemon.store.getThread(threadId);
  expect(["working", "waiting", "needs_you"]).not.toContain(there?.status.state);
  // The parent no longer waits on it.
  await vi.waitFor(
    () =>
      expect(
        Object.values(
          pair.source.daemon.store.snapshotThread(pair.source.caller.threadId).backgroundTasks,
        ).filter((task) => task.kind === "subagent" && task.status === "running"),
      ).toEqual([]),
    { timeout: 15_000 },
  );
}, 60_000);
