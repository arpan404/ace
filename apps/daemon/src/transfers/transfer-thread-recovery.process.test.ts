import { expect, it, vi } from "vitest";
import { ThreadId } from "@ace/protocol";
import { finishedThread, registered, transferMachines } from "./transfer-test-support.ts";

it("a target that stops after making the thread finishes its setup on restart, unarchived with its handoff", async () => {
  const m = await transferMachines();
  const source = await finishedThread(m, "Fix the login bug on the settings page");
  // The target dies between making the thread and giving it the handoff: the setup's
  // transaction never commits.
  const engine = m.target.daemon.engine;
  if (!engine) throw new Error("No engine there");
  vi.spyOn(engine, "adoptMachineHandoff").mockImplementationOnce(() => {
    throw new Error("The machine stopped");
  });
  await m.here.command({
    type: "thread.continueOn",
    threadId: source.threadId,
    hostId: m.targetHostId,
    includeChanges: true,
  });
  const made = await vi.waitFor(
    () => {
      const row = m.target.daemon.store
        .statement("SELECT id FROM threads WHERE title=?")
        .get("Login bug (from MacBook)");
      if (!row) throw new Error("No thread there yet");
      return ThreadId.parse(row["id"]);
    },
    { timeout: 60_000, interval: 50 },
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
