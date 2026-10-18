import { expect, test } from "vitest";
import { Agent, AgentId, Item, RunId, type ToolDetail } from "@ace/protocol";
import { end, root, start, storeFixture, tool, turns } from "./long-thread-test-support.ts";

const edit = (path: string): ToolDetail => ({
  kind: "file.edit",
  changes: [{ path, kind: "add", newText: "a\nb\n" }],
});

/** A succeeded edit by `agent` in run `runId`. */
function editBy(agent: AgentId, id: string, path: string, runId: string) {
  const item = tool(id, "succeeded", edit(path), runId);
  if (item.type !== "tool_call") throw new Error("Expected a tool call");
  return Item.parse({ ...item, agentId: agent, call: { ...item.call, agentId: agent } });
}

// Mutations: reading the main agent's share from the whole turn, or leaving it out. Not
// executed (tests run at merge).
test("a turn attributes each changed file to the agent that changed it", () => {
  const f = storeFixture();
  const child = AgentId.parse("helper");
  start(f.store, f.thread, "first", 20);
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "agent.created",
        agent: Agent.parse({
          id: child,
          threadId: f.thread.id,
          parentId: root,
          origin: "provider_subagent",
          fidelity: "full",
          native: { provider: "codex" },
          cwd: f.home,
          status: { state: "working", activity: "tool" },
          createdAt: 21,
        }),
      },
      {
        type: "run.started",
        run: {
          id: RunId.parse("helper-run"),
          threadId: f.thread.id,
          agentId: child,
          trigger: "spawn",
          state: "active",
          startedAt: 21,
        },
      },
      { type: "item.created", item: editBy(root, "main-edit", "src/main.ts", "first") },
      { type: "item.created", item: editBy(child, "helper-edit", "src/helper.ts", "helper-run") },
    ],
    22,
  );
  end(f.store, f.thread, "first", 30);
  const [turn] = turns(f.store, f.thread).turns;
  expect(turn?.digest.files.map((file) => file.path).toSorted()).toEqual([
    "src/helper.ts",
    "src/main.ts",
  ]);
  expect(turn?.main?.agentId).toBe(root);
  expect(turn?.main?.digest.files).toEqual([{ path: "src/main.ts", added: 2, removed: 0 }]);
  expect(turn?.subagents.find((agent) => agent.agentId === child)?.digest.files).toEqual([
    { path: "src/helper.ts", added: 2, removed: 0 },
  ]);
});
