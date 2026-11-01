import { expect, it, vi } from "vitest";
import { z } from "zod";
import { ThreadId, type AgentControlOperation, type Item } from "@ace/protocol";
import { pairedMachines } from "./machine-test-support.ts";

const Delegated = z.object({ threadId: ThreadId });
const delegation = {
  op: "delegate_task",
  requestId: "review-on-studio",
  task: "Summarize the open pull requests",
  role: "Review-open-pull-requests",
  provider: "claude",
  machine: "studio",
  project: "project",
} satisfies AgentControlOperation;

const result = "**Two** pull requests are ready to merge: `#12` and `#14`.";

function parentItems(pair: Awaited<ReturnType<typeof pairedMachines>>): Item[] {
  const store = pair.source.daemon.store;
  return store.readItemPage(pair.source.caller.threadId, store.headSeq() + 1, 50, 256 * 1024).items;
}

it("a finished child on a paired machine reaches its parent as a delegated-child receipt, like a local child", async () => {
  const pair = await pairedMachines({ access: "operate" });
  await pair.source.call({ op: "machines" });
  const { threadId } = Delegated.parse((await pair.source.call(delegation)).data);

  // Nobody waits on it: the result is handed to the parent once the child finishes there.
  await pair.finishTask(threadId, delegation.task, result);

  // The parent's agent is still told, with the child's result in what it receives.
  await vi.waitFor(
    () =>
      expect((pair.source.h.inputs.get(pair.source.caller.threadId) ?? []).join("\n")).toContain(
        JSON.stringify(result).slice(1, -1),
      ),
    { timeout: 15_000 },
  );

  // The transcript shows it the way a local child's result shows: one receipt for the child,
  // next to the child's row that names its machine.
  await vi.waitFor(
    () =>
      expect(parentItems(pair)).toContainEqual(
        expect.objectContaining({
          type: "delegation.settled",
          origin: "ace",
          delivery: "ace-input",
          results: [expect.objectContaining({ threadId, outcome: "completed" })],
        }),
      ),
    { timeout: 15_000 },
  );
  const items = parentItems(pair);
  expect(items).toContainEqual(
    expect.objectContaining({
      type: "delegation.started",
      childThreadId: threadId,
      machine: expect.objectContaining({ name: "Studio" }),
    }),
  );
  // What was injected for the provider is never a message of its own in the transcript.
  const messages = items.filter((item) => item.type === "message" && item.role === "user");
  expect(JSON.stringify(messages)).not.toContain("pull requests are ready");
  expect(JSON.stringify(items)).not.toContain("[ace: ");
});
