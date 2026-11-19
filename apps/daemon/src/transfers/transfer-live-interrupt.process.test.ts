/*
 * The move's own interrupt (ADR 0191) against a message queued behind the working turn: two real
 * daemons, scripted providers. A process test because the queue, the Stop and the move's close
 * are the source engine's together.
 */
import { CommandId } from "@ace/protocol";
import { expect, it } from "vitest";
import { continueOn, sentTo, workingThread } from "./transfer-live-support.ts";
import { transferMachines } from "./transfer-test-support.ts";

it("keeps a follow-up queued while the turn works through the move's interrupt", async () => {
  const m = await transferMachines();
  const { threadId } = await workingThread(m);
  const queued = m.source.controls.delegations.command("queued-follow-up", {
    type: "thread.send",
    threadId,
    input: [{ type: "text", text: "Also update the docs" }],
    delivery: "queue",
  });
  expect(queued).toMatchObject({ ok: true });
  await m.source.daemon.engine?.flush();
  await continueOn(m, threadId);
  const transfer = await m.settled();
  expect(transfer).toMatchObject({ phase: "completed", live: { stage: "moved" } });
  // Interrupted between tool calls, as a working turn is.
  expect(m.source.h.interrupts).toContain(threadId);
  const fate = m.source.daemon.engine?.inputFate(threadId, CommandId.parse("queued-follow-up"));
  expect(fate?.state).not.toBe("failed");
  expect(sentTo(m.source, threadId)).not.toContain("Also update the docs");
  expect(m.source.daemon.engine?.queue(threadId).messages).toHaveLength(1);
});
