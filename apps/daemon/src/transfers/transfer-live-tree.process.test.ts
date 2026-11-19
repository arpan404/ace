/*
 * Moving a thread whose agent has subagents working under it (ADR 0191): two real daemons, real
 * agent control and a real delegation tree of scripted CLI sessions. A process test because the
 * move now stops the tree with ace's own Stop, the cascade through every level and the status
 * rules that say when it is really at rest.
 */
import { expect, it, vi } from "vitest";
import type { McpAttribution, ThreadId } from "@ace/protocol";
import { continueOn, sentTo, workingThread } from "./transfer-live-support.ts";
import { transferMachines, type Machines } from "./transfer-test-support.ts";

/** An agent tool call from the root agent of `threadId`. */
function asAgent(m: Machines, threadId: ThreadId): McpAttribution {
  const agentId = m.source.daemon.store.getThread(threadId)?.rootAgentId;
  if (!agentId) throw new Error("No root agent");
  return { sessionId: "test", threadId, agentId };
}

/** Delegates a working Claude subagent from `parent`, and waits until its turn runs. */
async function delegate(m: Machines, parent: ThreadId, role: string, task: string) {
  const result = await m.source.controls.port.execute(
    asAgent(m, parent),
    { op: "delegate_task", requestId: role, task, role, provider: "claude" },
    new AbortController().signal,
  );
  expect(result).toMatchObject({ ok: true });
  const child = await vi.waitFor(
    async () => {
      await m.source.daemon.engine?.flush();
      const edge = m.source.controls.delegations.journal
        .children(parent)
        .find((entry) => entry.request.role === role);
      if (!edge || m.source.daemon.store.getThread(edge.childId)?.status.state !== "working")
        throw new Error("Subagent not working yet");
      return edge.childId;
    },
    { timeout: 20_000, interval: 50 },
  );
  return child;
}

it("stops the whole tree with ace's own Stop before it moves, and says what stopped", async () => {
  const m = await transferMachines();
  const { threadId } = await workingThread(m);
  const child = await delegate(m, threadId, "tests", "Write the tests");
  const grandchild = await delegate(m, child, "flaky", "Fix the flaky test");

  expect(await continueOn(m, threadId)).toMatchObject({ ok: true });
  const transfer = await m.settled();
  expect(transfer.error).toBeUndefined();
  expect(transfer).toMatchObject({ phase: "completed", live: { stage: "moved" } });

  // The cascade reached every level through the real providers' interrupts.
  for (const id of [threadId, child, grandchild]) expect(m.source.h.interrupts).toContain(id);
  for (const id of [child, grandchild])
    expect(m.source.daemon.store.getThread(id)?.status.state).not.toBe("working");
  // A delegation the stopped root's ending turn still asks for is refused.
  await expect(
    m.source.controls.port.execute(
      asAgent(m, threadId),
      {
        op: "delegate_task",
        requestId: "late",
        task: "One more",
        role: "late",
        provider: "claude",
      },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "delegation_cancelled" });
  // The agent there is told which subagents stopped, so it can start them again.
  const newId = transfer.result?.threadId;
  if (!newId) throw new Error("No thread there");
  const message = sentTo(m.target, newId).join("\n");
  // Listed by their titles, which a delegated thread takes from its role.
  expect(message).toMatch(/Subagent threads stopped on MacBook: (flaky, tests|tests, flaky)\./);
});

it("refuses a second move of a thread already moving", async () => {
  const m = await transferMachines();
  const { threadId } = await workingThread(m);
  const [first, second] = await Promise.all([continueOn(m, threadId), continueOn(m, threadId)]);
  const refused = [first, second].filter((receipt) => !receipt.ok);
  expect(refused).toHaveLength(1);
  expect(refused[0]).toMatchObject({ code: "thread_moving" });
  expect(await m.settled()).toMatchObject({ phase: "completed" });
});
