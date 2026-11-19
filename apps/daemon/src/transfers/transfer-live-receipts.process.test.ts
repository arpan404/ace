/*
 * A live move (ADR 0191) whose answer is lost after retention dropped the target's row: exactly
 * one thread there. Two real daemons over their pinned link, because the guarantee is in their
 * rows, their retention and their calls.
 */
import { expect, it } from "vitest";
import { MachineFailure } from "../machines/transport.ts";
import { continueOn, op, workingThread } from "./transfer-live-support.ts";
import { transferMachines, type Machines } from "./transfer-test-support.ts";

/** Threads on the target that continue the source's thread. */
const continuations = (m: Machines, threadId: string) =>
  m.target.daemon.store
    .listThreads()
    .filter((thread) => thread.details?.continuedFrom?.threadId === threadId);

it("answers from its receipt after retention dropped the row, so a lost answer never lands twice", async () => {
  let m: Machines | undefined;
  let lose = true;
  m = await transferMachines({
    transport: (inner) => async (profile, route, options) => {
      const answer = await inner(profile, route, options);
      const state = (answer as { state?: string } | undefined)?.state;
      if (lose && op(route) === "status" && state === "completed" && m) {
        lose = false;
        // The answer is lost, and a day later retention drops the target's row.
        const id = String(JSON.parse(String(route.body)).transferId);
        m.target.daemon.store
          .statement("DELETE FROM transfer_incoming WHERE transfer_id=?")
          .run(id);
        // Time moved on there, so a second import would be an attempt of its own.
        m.target.h.clock.advance(m.target.h.clock.now() + 1_000);
        throw new MachineFailure("disconnected");
      }
      return answer;
    },
  });
  const { threadId } = await workingThread(m);
  await continueOn(m, threadId);
  const transfer = await m.settled();
  expect(lose).toBe(false);
  expect(transfer).toMatchObject({ phase: "completed", live: { stage: "moved" } });
  const there = continuations(m, threadId);
  expect(there.map((thread) => thread.id)).toEqual([transfer.result?.threadId]);
  expect(m.source.daemon.store.getThread(threadId)?.status).toMatchObject({
    state: "moved",
    to: { threadId: transfer.result?.threadId },
  });
});
