/*
 * A moved thread with a message still held in its queue (ADR 0191) on a machine that runs one
 * thread at a time: two real daemons, scripted providers. A process test because the defect is
 * the engine's slots, shared by every thread on the machine.
 */
import type { Fact } from "@ace/core";
import { expect, it, vi } from "vitest";
import { continueOn, sentTo, workingThread } from "./transfer-live-support.ts";
import { repositoryWithOrigin, transferMachines } from "./transfer-test-support.ts";

const build = (status: "running" | "succeeded"): Fact => ({
  type: "item.upsert",
  agent: "root",
  item: "build",
  draft: {
    type: "tool_call",
    complete: status === "succeeded",
    call: {
      kind: "shell",
      title: "bun run build",
      status,
      detail: { kind: "shell", command: "bun run build" },
      raw: [],
    },
  },
});

it("frees the moved thread's slot, so other work runs here at the active-thread limit", async () => {
  const m = await transferMachines({ sourceEngineLimits: { maxActiveThreads: 1 } });
  const { threadId } = await workingThread(m);
  // A message held behind the turn, which ends by itself mid-stop: nothing pauses the queue.
  await m.source.h.emit(threadId, build("running"));
  m.source.controls.delegations.command("held", {
    type: "thread.send",
    threadId,
    input: [{ type: "text", text: "Also update the docs" }],
    delivery: "queue",
  });
  await continueOn(m, threadId);
  await vi.waitFor(
    () => {
      if (m.source.daemon.transfers.outgoing.list()[0]?.live?.stage !== "stopping")
        throw new Error("Not stopping yet");
    },
    { timeout: 30_000, interval: 20 },
  );
  await m.source.h.emit(threadId, build("succeeded"), {
    type: "turn.ended",
    agent: "root",
    outcome: "completed",
  });
  expect(await m.settled()).toMatchObject({ phase: "completed", live: { stage: "moved" } });
  // Another thread here gets the machine's one slot and runs.
  const other = await repositoryWithOrigin(m.sourceRoot, "other");
  const created = m.source.controls.delegations.command("other-work", {
    type: "thread.create",
    workspaceId: await m.addProject(m.source, other.path),
    provider: "codex",
    title: "Other",
    access: "full-access",
    input: [{ type: "text", text: "Fix the footer" }],
  });
  expect(created).toMatchObject({ ok: true });
  const otherId = created.threadId;
  if (!otherId) throw new Error("Not created");
  await vi.waitFor(
    async () => {
      await m.source.daemon.engine?.flush();
      expect(sentTo(m.source, otherId)).toContain("Fix the footer");
    },
    { timeout: 20_000, interval: 100 },
  );
  expect(sentTo(m.source, threadId)).not.toContain("Also update the docs");
});
