/*
 * A failed move (ADR 0191) whose resume message meets a full engine here: two real daemons, real
 * admission and command receipts, scripted providers. A process test because the defect was a
 * one-shot send the engine refused while another thread held the machine's only slot.
 */
import { expect, it, vi } from "vitest";
import { MachineFailure } from "../machines/transport.ts";
import { continueOn, op, sentTo, workingThread } from "./transfer-live-support.ts";
import { repositoryWithOrigin, transferMachines } from "./transfer-test-support.ts";

it("tells the agent to carry on once the slot another thread took frees, however long that is", async () => {
  const seenFinal = Promise.withResolvers<void>();
  const busyHoldsSlot = Promise.withResolvers<void>();
  const m = await transferMachines({
    sourceEngineLimits: { maxActiveThreads: 1 },
    transport: (inner) => async (profile, route, options) => {
      // The move fails before the hand-over, but only once another thread holds the slot.
      if (op(route) === "chunk:final") {
        seenFinal.resolve();
        await busyHoldsSlot.promise;
        throw new MachineFailure("refused", "invalid", "No room.");
      }
      return inner(profile, route, options);
    },
  });
  const { threadId } = await workingThread(m);
  await continueOn(m, threadId);
  await seenFinal.promise;
  const other = await repositoryWithOrigin(m.sourceRoot, "busy");
  const busy = m.source.controls.delegations.command("busy-here", {
    type: "thread.create",
    workspaceId: await m.addProject(m.source, other.path),
    provider: "claude",
    title: "Busy",
    access: "full-access",
    input: [{ type: "text", text: "Keep going" }],
  });
  const busyId = busy.threadId;
  if (!busyId) throw new Error(`Not created: ${busy.error}`);
  await m.source.daemon.engine?.flush();
  busyHoldsSlot.resolve();
  expect(await m.settled()).toMatchObject({ phase: "failed", live: { stage: "resumed" } });
  // Refused while the other thread works: nothing reached the agent yet.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(sentTo(m.source, threadId).join("\n")).not.toContain("didn't work");
  // The other thread finishes, so its warm session can give up the slot.
  await m.source.h.emit(busyId, { type: "turn.ended", agent: "root", outcome: "completed" });
  await m.source.daemon.engine?.flush();
  await vi.waitFor(
    async () => {
      m.source.h.clock.advance(m.source.h.clock.now() + 5_000);
      await m.source.daemon.engine?.flush();
      expect(sentTo(m.source, threadId).join("\n")).toContain(
        "Moving this thread to Studio didn't work",
      );
    },
    { timeout: 30_000, interval: 200 },
  );
});
