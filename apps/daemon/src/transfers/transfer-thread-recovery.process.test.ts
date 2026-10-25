import { expect, it, vi } from "vitest";
import { ThreadId } from "@ace/protocol";
import { finishedThread, registered, transferMachines } from "./transfer-test-support.ts";

type Machines = Awaited<ReturnType<typeof transferMachines>>;

/** Until the target restarts, giving a thread its handoff fails: its setup never commits. */
function setupFailsUntilRestart(m: Machines) {
  const engine = m.target.daemon.engine;
  if (!engine) throw new Error("No engine there");
  vi.spyOn(engine, "adoptMachineHandoff").mockImplementation(() => {
    throw new Error("The machine stopped");
  });
}

/** The thread the transfer made there, once it exists. */
function madeThere(m: Machines) {
  return vi.waitFor(
    () => {
      const row = m.target.daemon.store
        .statement("SELECT id FROM threads WHERE title=?")
        .get("Login bug (from MacBook)");
      if (!row) throw new Error("No thread there yet");
      return ThreadId.parse(row["id"]);
    },
    { timeout: 60_000, interval: 50 },
  );
}

it("a target that fails right after committing the new thread keeps that thread through a restart", async () => {
  const m = await transferMachines();
  const source = await finishedThread(m, "Fix the login bug on the settings page");
  setupFailsUntilRestart(m);
  // The step that makes the thread commits, then the target fails before anything else runs.
  const store = m.target.daemon.store;
  const record = store.recordCommand.bind(store);
  let failed = false;
  const making = vi.spyOn(store, "recordCommand").mockImplementation((id, device, run) => {
    const result = record(id, device, run);
    if (!id.startsWith("transfer-thread:")) return result;
    making.mockRestore();
    failed = true;
    throw new Error("The machine stopped");
  });
  await m.here.command({
    type: "thread.continueOn",
    threadId: source.threadId,
    hostId: m.targetHostId,
    includeChanges: true,
  });
  const made = await madeThere(m);
  await vi.waitFor(() => expect(failed).toBe(true), { timeout: 30_000 });
  await m.restartTarget();

  const transfer = await m.settled();
  expect(transfer).toMatchObject({ phase: "completed", result: { threadId: made } });
  const there = m.target.daemon.store.getThread(made);
  expect(there?.archivedAt).toBeUndefined();
  expect(there?.details?.continuedFrom).toMatchObject({ threadId: source.threadId });
  expect(registered(m.target)).toContain(transfer.result?.path);
  // Nothing was rolled back and made again: the one thread there is the first one.
  expect(
    m.target.daemon.store
      .statement("SELECT id FROM threads WHERE title=?")
      .all("Login bug (from MacBook)")
      .map((row) => row["id"]),
  ).toEqual([made]);
});

it("a target that stops after making the thread finishes its setup on restart, unarchived with its handoff", async () => {
  const m = await transferMachines();
  const source = await finishedThread(m, "Fix the login bug on the settings page");
  // The target fails between making the thread and giving it the handoff.
  setupFailsUntilRestart(m);
  await m.here.command({
    type: "thread.continueOn",
    threadId: source.threadId,
    hostId: m.targetHostId,
    includeChanges: true,
  });
  const made = await madeThere(m);
  const [sending] = m.source.daemon.transfers.outgoing.list();
  if (!sending) throw new Error("No transfer here");
  // Past the cutoff, a cancel is too late: the source never reads it as cancelled.
  await vi.waitFor(
    () => {
      const row = m.target.daemon.store
        .statement("SELECT result FROM transfer_incoming WHERE transfer_id=?")
        .get(sending.transferId);
      if (!row?.["result"]) throw new Error("No result there yet");
    },
    { timeout: 30_000, interval: 20 },
  );
  expect(await m.here.request({ op: "cancel", transferId: sending.transferId })).toMatchObject({
    kind: "error",
    code: "too_late",
  });
  expect(m.source.daemon.transfers.outgoing.get(sending.transferId)?.transfer.phase).toBe(
    "importing",
  );
  await m.restartTarget();

  const transfer = await m.settled();
  expect(transfer).toMatchObject({ phase: "completed", result: { threadId: made } });
  const there = m.target.daemon.store.getThread(made);
  expect(there?.archivedAt).toBeUndefined();
  expect(there?.details?.continuedFrom).toMatchObject({ threadId: source.threadId });
  expect(registered(m.target)).toContain(transfer.result?.path);

  // The person's next message there carries the source thread's history.
  m.target.controls.delegations.command("next-there", {
    type: "thread.send",
    threadId: made,
    input: [{ type: "text", text: "Carry on" }],
  });
  await m.target.daemon.engine?.flush();
  await vi.waitFor(
    () => {
      const sent = m.target.h.attempts
        .filter((attempt) => attempt.threadId === made)
        .map((attempt) => attempt.text)
        .join("\n");
      if (!sent.includes("Carry on")) throw new Error("Not sent yet");
      expect(sent).toContain("Fix the login bug on the settings page");
    },
    { timeout: 30_000, interval: 50 },
  );
});
