import { expect, it, vi } from "vitest";
import { z } from "zod";
import { ThreadId, type AgentControlOperation } from "@ace/protocol";
import { pairedMachines } from "./machine-test-support.ts";

const Delegated = z.object({ threadId: ThreadId });

/** A child delegated to the paired machine `studio`, its first turn still running there. */
async function remoteChild(pair: Awaited<ReturnType<typeof pairedMachines>>) {
  await pair.source.call({ op: "machines" });
  const started = await pair.source.call({
    op: "delegate_task",
    requestId: "fix-on-studio",
    task: "Fix the flaky test",
    role: "Fix-flaky-test",
    provider: "claude",
    machine: "studio",
    project: "project",
  });
  const { threadId } = Delegated.parse(started.data);
  await vi.waitFor(() => {
    if (pair.target.daemon.store.getThread(threadId)?.status.state !== "working")
      throw new Error("Not running yet");
  });
  return threadId;
}

const message = (
  threadId: ThreadId,
  text: string,
  delivery?: "queue" | "steer" | "restart",
): AgentControlOperation => ({
  op: "thread.message",
  threadId,
  requestId: `message-${text.length}`,
  text,
  ...(delivery ? { delivery } : {}),
});

const received = (pair: Awaited<ReturnType<typeof pairedMachines>>, id: ThreadId) =>
  pair.target.h.inputs.get(id) ?? [];

it("a parent messages its child on another machine and is told the message waits for the turn", async () => {
  const pair = await pairedMachines({ access: "operate" });
  const child = await remoteChild(pair);
  const sent = await pair.source.call(message(child, "Also cover the retry path"));
  expect(sent).toMatchObject({ ok: true, data: { arrival: "queued" } });
  await pair.target.daemon.engine?.flush();
  expect(received(pair, child)).not.toContain("Also cover the retry path");
  // A retried call is the same message, never a second one.
  await pair.source.call(message(child, "Also cover the retry path"));
  await pair.finish(child, "Fixed the test.");
  await vi.waitFor(() => expect(received(pair, child)).toContain("Also cover the retry path"));
  expect(received(pair, child).filter((text) => text === "Also cover the retry path")).toHaveLength(
    1,
  );
});

it("a restart sent to another machine stops the child's turn there and starts the next", async () => {
  const pair = await pairedMachines({ access: "operate" });
  const child = await remoteChild(pair);
  const sent = await pair.source.call(message(child, "Start over from main", "restart"));
  expect(sent).toMatchObject({ ok: true, data: { arrival: "starting" } });
  await vi.waitFor(() => expect(received(pair, child).at(-1)).toBe("Start over from main"));
});

it("a machine that now lets agents only read refuses the message and says why", async () => {
  const pair = await pairedMachines({ access: "operate" });
  const child = await remoteChild(pair);
  await pair.access("read");
  await expect(pair.source.call(message(child, "Keep going"))).rejects.toMatchObject({
    code: "machine_forbidden",
  });
  expect(received(pair, child)).not.toContain("Keep going");
});

it("a message to a child on a machine that went offline fails clearly instead of vanishing", async () => {
  const pair = await pairedMachines({ access: "operate" });
  const child = await remoteChild(pair);
  await pair.target.daemon.close();
  await expect(pair.source.call(message(child, "Keep going"))).rejects.toMatchObject({
    code: "machine_offline",
  });
});
