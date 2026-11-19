import { expect, test } from "vitest";
import { AgentId, ThreadId, WorkspaceId, type Thread } from "@ace/protocol";
import { acceptIntents } from "./notification-intents.ts";

const thread = (id: string, host?: "spade"): Thread => ({
  id: ThreadId.parse(id),
  workspaceId: WorkspaceId.parse("w"),
  title: id,
  provider: "codex",
  status: { state: "done" },
  createdAt: 1,
  updatedAt: 1,
  ...(host ? { host } : {}),
});

test("a notice from Spade's hidden host thread is acknowledged without alerting; others alert", async () => {
  const threads = new Map([
    ["spade-host", thread("spade-host", "spade")],
    ["child", thread("child")],
  ]);
  const intents = ["spade-host", "child"].map((threadId) => ({
    id: `intent-${threadId}`,
    intent: {
      type: "mcp.notify" as const,
      threadId: ThreadId.parse(threadId),
      agentId: AgentId.parse("agent"),
      notice: { level: "info" as const, text: `from ${threadId}` },
    },
  }));
  const acknowledged: string[] = [];
  const notified: string[] = [];
  const more = await acceptIntents(
    {
      readMcpIntents: () => intents.filter((each) => !acknowledged.includes(each.id)),
      getThread: (id) => threads.get(id),
      writable: async () => {},
      acknowledgeMcpIntent: (id) => {
        acknowledged.push(id);
        return true;
      },
    } as Parameters<typeof acceptIntents>[0],
    {
      notify: async (notification) => {
        notified.push(notification.threadId);
      },
    },
    [],
  );
  expect(more).toBe(false);
  expect(notified).toEqual(["child"]);
  expect(acknowledged).toEqual(["intent-spade-host", "intent-child"]);
});
