/*
 * Moving a working thread to another machine (ADR 0191), end to end: two real daemons over their
 * pinned TLS link, real Git, scripted providers. A process test because the switch-over is the
 * wiring between two engines, their transfer rows and their ownership records; the pure rules
 * are tested in live/*.test.ts, restarts and lost links in transfer-live-recovery.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ThreadOwnership } from "./live/ownership.ts";
import { continueOn, op, sentTo, workingThread } from "./transfer-live-support.ts";
import { git, transferMachines } from "./transfer-test-support.ts";

it("moves a working thread: stopped here, started there by itself, and only then read moved", async () => {
  let late: (() => Promise<void>) | undefined;
  const m = await transferMachines({
    // A file the agent writes after the bulk left still arrives, in the final payload.
    transport: (inner) => async (profile, route, options) => {
      if (op(route) === "chunk:code" && late) {
        const write = late;
        late = undefined;
        await write();
      }
      return inner(profile, route, options);
    },
  });
  const { path, threadId } = await workingThread(m);
  late = () => writeFile(join(path, "late.txt"), "written while the bulk was sent\n");

  expect(await continueOn(m, threadId)).toMatchObject({ ok: true, threadId });
  const transfer = await m.settled();
  expect(transfer.error).toBeUndefined();
  expect(transfer).toMatchObject({ phase: "completed", live: { stage: "moved" } });
  const newId = transfer.result?.threadId;
  if (!newId) throw new Error("No thread there");

  // Stopped here with the provider's own interrupt.
  expect(m.source.h.interrupts).toContain(threadId);
  // There, the agent was told it moved, and its turn runs without anyone sending a message.
  const there = sentTo(m.target, newId).join("\n");
  expect(there).toContain("This thread moved here from MacBook while you were working");
  // The scripted provider keeps no session files here, so the summary went instead.
  expect(there).toContain("Your conversation came as the summary above");
  expect(m.target.daemon.store.getThread(newId)?.status.state).toBe("working");
  const landed = transfer.result?.path ?? "";
  expect(await readFile(join(landed, "late.txt"), "utf8")).toBe(
    "written while the bulk was sent\n",
  );
  expect(await git(landed, "status", "--porcelain")).toBe("?? late.txt\n?? wip.txt");

  // Exactly one machine owns it: the target, from the machine it left.
  expect(new ThreadOwnership(m.target.daemon.store).get(newId)).toMatchObject({
    state: "owned",
    epoch: 1,
    peer: { name: "MacBook", threadId },
  });
  expect(new ThreadOwnership(m.source.daemon.store).get(threadId)).toMatchObject({
    state: "moved",
    peer: { name: "Studio", threadId: newId },
  });
  // Here it reads moved, never done, and takes no new turn.
  expect(m.source.daemon.store.getThread(threadId)?.status).toEqual({
    state: "moved",
    to: { hostId: m.targetHostId, name: "Studio", threadId: newId },
  });
  expect(
    m.source.controls.delegations.command("after-move", {
      type: "thread.send",
      threadId,
      input: [{ type: "text", text: "One more thing" }],
    }),
  ).toMatchObject({ ok: false, error: "thread_moved" });
});

it("stops a build the finished turn left running before it moves the thread, and says so there", async () => {
  const m = await transferMachines();
  const { threadId } = await workingThread(m);
  await m.source.h.emit(threadId, {
    type: "background.started",
    agent: "root",
    task: "build",
    kind: "shell",
    title: "bun run build --watch",
    stoppable: true,
  });
  await m.source.h.emit(threadId, { type: "turn.ended", agent: "root", outcome: "completed" });
  await m.source.daemon.engine?.flush();
  expect(await continueOn(m, threadId)).toMatchObject({ ok: true });
  const transfer = await m.settled();
  const newId = transfer.result?.threadId;
  if (!newId) throw new Error("No thread there");
  // Stopped here by ace's own Stop, so nothing of it writes once the snapshot is taken.
  expect(m.source.h.stoppedTasks).toContain("build");
  expect(sentTo(m.target, newId).join("\n")).toContain("bun run build --watch");
  // At rest when the move began, so the agent isn't told to carry on anything here.
  expect(sentTo(m.source, threadId).join("\n")).not.toContain("didn't work");
});
