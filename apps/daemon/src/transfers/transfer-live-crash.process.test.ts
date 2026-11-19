/*
 * A live move (ADR 0191) whose source crashed between the hand-over's two writes, then lost its
 * target for longer than the retry limit: it must keep the thread handed over and move it once
 * the target answers. Two real daemons, a real restart and a real outage of the link.
 */
import { expect, it, vi } from "vitest";
import type { TransferTransport } from "./client.ts";
import { MachineFailure } from "../machines/transport.ts";
import { continueOn, op, workingThread } from "./transfer-live-support.ts";
import { transferMachines, type Machines } from "./transfer-test-support.ts";

const continuations = (m: Machines, threadId: string) =>
  m.target.daemon.store
    .listThreads()
    .filter((thread) => thread.details?.continuedFrom?.threadId === threadId);

it("treats a crash between the hand-over's two writes as handed over, and waits out a long outage", async () => {
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  let holding = true;
  let offline = false;
  /** When the restarted source first found the target unreachable. */
  let outageSeen: number | undefined;
  const wrap =
    (inner: TransferTransport): TransferTransport =>
    async (profile, route, options) => {
      if (holding && op(route) === "commit") await held;
      if (offline) {
        outageSeen ??= restarted ? Date.now() : undefined;
        throw new MachineFailure("offline");
      }
      return inner(profile, route, options);
    };
  let restarted = false;
  const m = await transferMachines({ transport: wrap });
  const { threadId } = await workingThread(m);
  await continueOn(m, threadId);
  await vi.waitFor(
    () => {
      if (m.source.daemon.transfers.outgoing.list()[0]?.live?.stage !== "handing")
        throw new Error("Not handed over yet");
    },
    { timeout: 30_000 },
  );
  // The ownership record says handing; the row is left saying stopping, as a crash between two
  // separate writes would leave it. The target then stays unreachable past the retry limit.
  offline = true;
  holding = false;
  release();
  m.source.daemon.store
    .statement("UPDATE transfer_outgoing SET record=json_set(record,'$.live.stage','stopping')")
    .run();
  restarted = true;
  await m.restartSource(wrap);
  // Unreachable for longer than the source's 5 s retry limit, on its own clock.
  await vi.waitFor(
    () => {
      if (outageSeen === undefined) throw new Error("Not trying yet");
    },
    { timeout: 30_000, interval: 50 },
  );
  m.source.h.clock.advance(m.source.h.clock.now() + 10_000);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(m.source.daemon.transfers.outgoing.list()[0]?.phase).not.toBe("failed");
  expect(m.source.daemon.store.getThread(threadId)?.status.state).not.toBe("done");
  offline = false;
  const transfer = await m.settled();
  expect(transfer).toMatchObject({ phase: "completed", live: { stage: "moved" } });
  expect(continuations(m, threadId)).toHaveLength(1);
});
