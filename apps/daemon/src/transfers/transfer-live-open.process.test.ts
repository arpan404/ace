/*
 * A provider session that was opening when the thread was fenced for a move (ADR 0191): one real
 * daemon with a scripted provider whose opening is held, because the race is between the engine's
 * session open and the ownership record.
 */
import { CommandId } from "@ace/protocol";
import { expect, it, vi } from "vitest";
import { ThreadOwnership } from "./live/ownership.ts";
import { sentTo, workingThread } from "./transfer-live-support.ts";
import { transferMachines } from "./transfer-test-support.ts";

it("ends a session that finished opening after the move fenced it, and keeps the send held", async () => {
  let gate = Promise.withResolvers<void>();
  gate.resolve();
  const entered = { count: 0 };
  const m = await transferMachines({
    sourceOpening: {
      entered: () => {
        entered.count++;
      },
      get ready() {
        return gate.promise;
      },
    },
  });
  const { threadId } = await workingThread(m);
  await m.source.h.emit(threadId, { type: "turn.ended", agent: "root", outcome: "completed" });
  await m.source.daemon.engine?.flush();
  await m.source.daemon.engine?.liveMove.closeProvider(threadId);
  // The next session waits inside the provider's open.
  gate = Promise.withResolvers<void>();
  const before = entered.count;
  m.source.controls.delegations.command("parked", {
    type: "thread.send",
    threadId,
    input: [{ type: "text", text: "One more thing" }],
  });
  await vi.waitFor(() => {
    if (entered.count === before) throw new Error("Not opening yet");
  });
  // The move fences the thread while that open is still in flight.
  new ThreadOwnership(m.source.daemon.store).change(threadId, {
    to: "stopping",
    transferId: "transfer-x",
    peer: { hostId: "studio", name: "Studio" },
    at: 1,
  });
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await m.source.daemon.engine?.flush();
  expect(sentTo(m.source, threadId)).not.toContain("One more thing");
  const fate = m.source.daemon.engine?.inputFate(threadId, CommandId.parse("parked"));
  expect(fate?.state).not.toBe("failed");
});
