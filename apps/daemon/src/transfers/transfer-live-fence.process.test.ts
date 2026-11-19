/*
 * A live move (ADR 0191) holds work queued here while it stops the thread: two real daemons over
 * their pinned link, scripted providers. A process test because the fence is the source engine's
 * own dispatch, reached through a real cutover.
 */
import type { Fact } from "@ace/core";
import { CommandId } from "@ace/protocol";
import { expect, it, vi } from "vitest";
import { continueOn, sentTo, workingThread } from "./transfer-live-support.ts";
import { transferMachines } from "./transfer-test-support.ts";

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

it("never runs a message queued before the stop, even when the turn ends by itself mid-stop", async () => {
  const m = await transferMachines();
  const { threadId } = await workingThread(m);
  // A tool call keeps the turn from a safe point, and a message waits behind the turn.
  await m.source.h.emit(threadId, build("running"));
  const queued = m.source.controls.delegations.command("queued-follow-up", {
    type: "thread.send",
    threadId,
    input: [{ type: "text", text: "Also update the docs" }],
    delivery: "queue",
  });
  expect(queued).toMatchObject({ ok: true });
  await m.source.daemon.engine?.flush();
  expect(await continueOn(m, threadId)).toMatchObject({ ok: true });
  await vi.waitFor(
    () => {
      if (m.source.daemon.transfers.outgoing.list()[0]?.live?.stage !== "stopping")
        throw new Error("Not stopping yet");
    },
    { timeout: 30_000, interval: 20 },
  );
  // The turn ends on its own while the move is stopping: the queued message must stay held.
  await m.source.h.emit(threadId, build("succeeded"), {
    type: "turn.ended",
    agent: "root",
    outcome: "completed",
  });
  await m.source.daemon.engine?.flush();
  const transfer = await m.settled();
  expect(transfer).toMatchObject({ phase: "completed", live: { stage: "moved" } });
  // Once the hold ends the thread wakes; give a reopened session time to take the message.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  await m.source.daemon.engine?.flush();
  expect(sentTo(m.source, threadId)).not.toContain("Also update the docs");
  // Held here, never lost: the message is still queued, and the thread reads moved.
  expect(
    m.source.daemon.engine?.inputFate(threadId, CommandId.parse("queued-follow-up")),
  ).not.toMatchObject({ state: "failed" });
  expect(
    JSON.stringify(
      m.source.daemon.engine?.queue(threadId).messages.map((message) => message.input),
    ),
  ).toContain("Also update the docs");
  expect(m.source.daemon.store.getThread(threadId)?.status.state).toBe("moved");
});
