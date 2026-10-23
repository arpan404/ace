import { expect, it, vi } from "vitest";
import { z } from "zod";
import { MonitorSnapshot, ThreadId, type AgentControlOperation } from "@ace/protocol";
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

it("a message that fails on the other machine reaches the parent here and shows in agents_status", async () => {
  const pair = await pairedMachines({ access: "operate" });
  const child = await remoteChild(pair);
  await pair.source.call(message(child, "Use the new API", "queue"));
  pair.target.h.failNextSend("rejected", "queue");
  await pair.finish(child, "First pass done.");
  const parent = pair.source.caller.threadId;
  await vi.waitFor(() =>
    expect((pair.source.h.inputs.get(parent) ?? []).join("\n")).toContain("wasn't sent"),
  );
  const status = MonitorSnapshot.parse((await pair.source.call({ op: "agents.status" })).data);
  expect(status.children).toEqual([
    expect.objectContaining({ id: child, notice: expect.stringContaining("wasn't sent") }),
  ]);
});

it("a finished child on another machine messaged again reports its next result too", async () => {
  const pair = await pairedMachines({ access: "operate" });
  const child = await remoteChild(pair);
  const parent = pair.source.caller.threadId;
  const results = () => (pair.source.h.inputs.get(parent) ?? []).join("\n");
  await pair.finish(child, "First pass done.");
  await vi.waitFor(() => expect(results()).toContain("First pass done."));
  expect(await pair.source.call(message(child, "Now the docs"))).toMatchObject({
    ok: true,
    data: { arrival: "starting" },
  });
  // Until it answers, the parent's tree reads working, never done.
  expect(pair.source.daemon.store.getThread(parent)?.status.state).not.toBe("done");
  await vi.waitFor(() => expect(received(pair, child)).toContain("Now the docs"));
  await pair.finish(child, "Docs updated.");
  await vi.waitFor(() => expect(results()).toContain("Docs updated."));
});

it("a restart sent to another machine also stops what that child delegated there", async () => {
  const pair = await pairedMachines({ access: "operate" });
  const child = await remoteChild(pair);
  const agentId = pair.target.daemon.store.getThread(child)?.rootAgentId;
  if (!agentId) throw new Error("No root agent");
  const delegations = pair.target.controls.delegations;
  const grandchild = delegations.delegate(
    { sessionId: "remote-child", threadId: child, agentId },
    {
      requestId: "helper",
      task: "Check the logs",
      role: "Check-logs",
      provider: "claude",
      model: "chosen-model",
      effort: "high",
      wait: false,
      estimatedLoad: 0,
    },
  ).childId;
  await pair.target.daemon.engine?.flush();
  expect(pair.target.daemon.store.getThread(grandchild)?.status.state).toBe("working");
  await pair.source.call(message(child, "Start over from main", "restart"));
  await vi.waitFor(() =>
    expect(pair.target.daemon.store.getThread(grandchild)?.status.state).not.toBe("working"),
  );
  expect(delegations.journal.get(grandchild)?.phase).not.toBe("running");
});

it("a notice from the other machine clears once the parent sends its child a new message", async () => {
  const pair = await pairedMachines({ access: "operate" });
  const child = await remoteChild(pair);
  await pair.source.call(message(child, "Use the new API", "queue"));
  pair.target.h.failNextSend("rejected", "queue");
  await pair.finish(child, "First pass done.");
  const notice = async () =>
    MonitorSnapshot.parse((await pair.source.call({ op: "agents.status" })).data).children[0]
      ?.notice;
  await vi.waitFor(async () => expect(await notice()).toContain("wasn't sent"));
  await pair.source.call(message(child, "Never mind, use the old one", "queue"));
  // Read once the other machine has been polled again, not from the reopened placeholder.
  await vi.waitFor(async () => {
    const [shown] = MonitorSnapshot.parse(
      (await pair.source.call({ op: "agents.status" })).data,
    ).children;
    expect(shown?.state).toBe("failed");
    expect(shown?.notice).toBeUndefined();
  });
});

it("a message whose reply is lost keeps a finished child on another machine working here", async () => {
  const pair = await pairedMachines({ access: "operate" });
  const child = await remoteChild(pair);
  const parent = pair.source.caller.threadId;
  await pair.finish(child, "First pass done.");
  await vi.waitFor(() =>
    expect((pair.source.h.inputs.get(parent) ?? []).join("\n")).toContain("First pass done."),
  );
  const store = pair.target.daemon.store;
  const record = store.recordCommand.bind(store);
  // The other machine takes the message, then goes away before it can answer.
  vi.spyOn(store, "recordCommand").mockImplementation((id, device, run) => {
    const result = record(id, device, run);
    if (String(id).startsWith("machine-message:")) void pair.target.daemon.close();
    return result;
  });
  await expect(pair.source.call(message(child, "Now the docs"))).rejects.toMatchObject({
    code: "machine_disconnected",
  });
  expect(pair.target.daemon.store.getThread(child)?.status.state).not.toBe("done");
  // Here the child is working again, so neither it nor its parent reads done.
  const status = MonitorSnapshot.parse((await pair.source.call({ op: "agents.status" })).data);
  expect(status.children).toEqual([expect.objectContaining({ id: child, state: "working" })]);
});
