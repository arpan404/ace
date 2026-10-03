import { expect, test } from "vitest";
import { summarizeThreadReference } from "@ace/context";
import { Thread, Item, ThreadRefContextItem } from "@ace/protocol";

test("thread references preserve a paging pointer and bound multibyte summary text", () => {
  const thread = Thread.parse({
    id: "source",
    workspaceId: "workspace",
    provider: "claude",
    title: "source",
    status: { state: "done" },
    createdAt: 0,
    updatedAt: 0,
  });
  const item = Item.parse({
    id: "result",
    agentId: "agent",
    createdAt: 0,
    complete: true,
    type: "message",
    role: "assistant",
    parts: [{ type: "text", text: "😀成果".repeat(5000) }],
  });
  const reference = ThreadRefContextItem.parse({
    type: "thread_ref",
    threadId: thread.id,
    budgetBytes: 1024,
  });
  const result = summarizeThreadReference(reference, thread, { items: [item], itemsBefore: 17 });
  expect(Buffer.byteLength(result.summary)).toBeLessThanOrEqual(1024);
  expect(result.summary).toContain("😀成果");
  expect(result.summary).toContain("Untrusted thread context");
  expect(result.summary).toContain("Summary truncated");
  expect(result.summary).not.toContain("�");
  expect(result.pointer).toEqual({ threadId: thread.id, before: 17 });
  expect(result.truncated).toBe(true);
});
