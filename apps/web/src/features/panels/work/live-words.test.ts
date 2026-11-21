import { Agent, type AgentStatus } from "@ace/protocol";
import { agentForest, type AgentForestNode, type ThreadWork } from "@ace/ui-core";
import { expect, test } from "vitest";
import { currentLive } from "@/lib/live-connection.ts";
import { agentRowWords } from "./live-words.ts";

/* What an agent row in the Summary says, from a real join of threads' facts. */

let clock = 0;
const agent = (
  threadId: string,
  id: string,
  status: AgentStatus,
  parentId: string | null = null,
  childThreadId?: string,
) =>
  Agent.parse({
    id,
    parentId,
    threadId,
    childThreadId,
    origin: parentId ? "ace" : "root",
    native: { provider: "claude", nativeId: `${threadId}-${id}` },
    fidelity: "full",
    cwd: "/project",
    status,
    createdAt: clock++,
  });
const idle: AgentStatus = { state: "idle" };
const working: AgentStatus = { state: "working", activity: "tool" };
const work = (agents: Agent[]): ThreadWork => ({
  agents,
  tasks: [],
  interactions: [],
  status: { state: "done" },
});

test("a delegate whose working thread shows under another row says it waits on that work, never done", () => {
  const works = new Map([
    [
      "t1",
      work([
        agent("t1", "root", idle),
        agent("t1", "first", idle, "root", "t2"),
        agent("t1", "again", idle, "root", "t2"),
      ]),
    ],
    ["t2", work([agent("t2", "root", idle), agent("t2", "busy", working, "root")])],
  ]);
  const again = agentForest("t1", works).roots[0]?.children.find(
    (node): node is AgentForestNode => node.kind === "agent" && node.agent.id === "again",
  );
  if (!again) throw new Error("no second delegate row");
  const words = agentRowWords(currentLive, again, {
    request: undefined,
    tool: undefined,
    spawn: undefined,
  });
  expect(words).toMatchObject({ step: "waiting on delegated work", done: false });
});
