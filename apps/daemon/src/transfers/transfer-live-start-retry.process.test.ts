/*
 * A moved thread whose first turn the target's engine refuses at first, because it is full
 * (ADR 0191): two real daemons, real command receipts, scripted providers. A process test because
 * the defect was the receipt of a refusal replaying on every retry.
 */
import { expect, it, vi } from "vitest";
import { LiveStarts } from "./live/target-rows.ts";
import { continueOn, sentTo, workingThread } from "./transfer-live-support.ts";
import { repositoryWithOrigin, transferMachines } from "./transfer-test-support.ts";

it("starts the moved thread once a slot frees there, though the full engine refused it first", async () => {
  const m = await transferMachines({ targetEngineLimits: { maxActiveThreads: 1 } });
  // A thread already working there holds the target's only slot.
  const busy = await repositoryWithOrigin(m.targetRoot, "busy");
  const created = m.target.controls.delegations.command("busy-there", {
    type: "thread.create",
    workspaceId: await m.addProject(m.target, busy.path),
    provider: "claude",
    title: "Busy",
    access: "full-access",
    input: [{ type: "text", text: "Keep going" }],
  });
  const busyId = created.threadId;
  if (!busyId) throw new Error(`Not created: ${created.error}`);
  await m.target.daemon.engine?.flush();
  const { threadId } = await workingThread(m);
  await continueOn(m, threadId);
  const starts = new LiveStarts(m.target.daemon.store);
  const transferId = () => m.source.daemon.transfers.outgoing.list()[0]?.transferId ?? "";
  // Refused while full.
  await vi.waitFor(
    () => {
      if (!((starts.get(transferId())?.attempts ?? 0) > 0)) throw new Error("Not refused yet");
    },
    { timeout: 30_000, interval: 50 },
  );
  // The busy thread finishes, so its warm session can give up the slot; time moves on there.
  await m.target.h.emit(busyId, { type: "turn.ended", agent: "root", outcome: "completed" });
  await m.target.daemon.engine?.flush();
  const later = vi.waitFor(
    () => {
      if (starts.get(transferId())?.running === undefined) {
        m.target.h.clock.advance(m.target.h.clock.now() + 5_000);
        throw new Error("Not started yet");
      }
    },
    { timeout: 30_000, interval: 200 },
  );
  await later;
  expect(starts.get(transferId())).toMatchObject({ running: true });
  const transfer = await m.settled();
  expect(transfer).toMatchObject({ phase: "completed", live: { stage: "moved" } });
  const newId = transfer.result?.threadId;
  if (!newId) throw new Error("No thread there");
  expect(sentTo(m.target, newId).join("\n")).toContain("This thread moved here from MacBook");
});
