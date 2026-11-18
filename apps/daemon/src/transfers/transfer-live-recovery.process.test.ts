/*
 * A live switch-over (ADR 0190) converging when the link drops or a daemon restarts mid-cutover:
 * the source resumes, or the target owns the thread, never both and never neither. Two real
 * daemons over their pinned TLS link, because the guarantee lives in their rows and their calls.
 */
import { expect, it, vi } from "vitest";
import type { TransferTransport } from "./client.ts";
import { MachineFailure } from "../machines/transport.ts";
import { continueOn, op, sentTo, workingThread } from "./transfer-live-support.ts";
import { transferMachines } from "./transfer-test-support.ts";

it("keeps a handed-over thread working here through a restart, until the target's answer moves it", async () => {
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  let holding = true;
  const hold =
    (inner: TransferTransport): TransferTransport =>
    async (profile, route, options) => {
      if (holding && op(route) === "commit") await held;
      return inner(profile, route, options);
    };
  const m = await transferMachines({ transport: hold });
  const { threadId } = await workingThread(m);
  await continueOn(m, threadId);
  // The commit is on its way: from here only the target's answer settles the thread.
  await vi.waitFor(
    () => {
      if (m.source.daemon.transfers.outgoing.list()[0]?.live?.stage !== "handing")
        throw new Error("Not handed over yet");
    },
    { timeout: 30_000 },
  );
  expect(m.source.daemon.store.getThread(threadId)?.status.state).not.toBe("done");
  holding = false;
  await m.restartSource();
  release();
  // After the restart it still refuses new turns while it waits.
  const refused = m.source.controls.delegations.command("during", {
    type: "thread.send",
    threadId,
    input: [{ type: "text", text: "Still there?" }],
  });
  expect(refused.ok).toBe(false);
  const transfer = await m.settled();
  expect(transfer).toMatchObject({ phase: "completed", live: { stage: "moved" } });
  expect(m.source.daemon.store.getThread(threadId)?.status.state).toBe("moved");
});

it("waits out a lost link once handed over, never running the thread here again on its own", async () => {
  let drops = 6;
  const m = await transferMachines({
    transport: (inner) => async (profile, route, options) => {
      const answer = await inner(profile, route, options);
      // The target heard every status call; its answers are lost on the way back.
      if (op(route) === "status" && drops > 0) {
        drops--;
        throw new MachineFailure("disconnected");
      }
      return answer;
    },
  });
  const { threadId } = await workingThread(m);
  await continueOn(m, threadId);
  const transfer = await m.settled();
  expect(drops).toBe(0);
  expect(transfer).toMatchObject({ phase: "completed", live: { stage: "moved" } });
  expect(sentTo(m.source, threadId).join("\n")).not.toContain("didn't work");
});

it("gives the thread back, told to carry on, when the move fails before the hand-over", async () => {
  const m = await transferMachines({
    transport: (inner) => async (profile, route, options) => {
      if (op(route) === "chunk:final") throw new MachineFailure("refused", "invalid", "No room.");
      return inner(profile, route, options);
    },
  });
  const { threadId } = await workingThread(m);
  await continueOn(m, threadId);
  const transfer = await m.settled();
  expect(transfer).toMatchObject({ phase: "failed", live: { stage: "resumed" } });
  await m.source.daemon.engine?.flush();
  await vi.waitFor(() =>
    expect(sentTo(m.source, threadId).join("\n")).toContain(
      "Moving this thread to Studio didn't work",
    ),
  );
  expect(m.source.daemon.store.getThread(threadId)?.status.state).not.toBe("moved");
});
