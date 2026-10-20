import { expect, test } from "vitest";
import { harness } from "./translator.test-helper.ts";

// Frame shapes follow Claude Code's Agent tool: the call's input carries `description`,
// `subagent_type`, `prompt` and `run_in_background`, and `task_started` repeats the description
// and agent type for the `local_agent` task that runs it.
type H = ReturnType<typeof harness>;

function launch(h: H, id: string, description: string, background: boolean) {
  h.tool(id, "Agent", {
    description,
    subagent_type: "general-purpose",
    prompt: `Work on: ${description}`,
    ...(background ? { run_in_background: true } : {}),
  });
  h.system("task_started", {
    task_id: `task-${id}`,
    tool_use_id: id,
    task_type: "local_agent",
    is_backgrounded: background,
    description,
    subagent_type: "general-purpose",
    prompt: `Work on: ${description}`,
  });
}
const subagents = (h: H) =>
  Object.values(h.state.agents)
    .map((record) => record.agent)
    .filter((agent) => agent.origin === "provider_subagent");

test("a foreground Agent-tool subagent is named by its description, with its type as role", () => {
  const h = harness();
  h.init();
  launch(h, "launch", "Count lines in src files", false);
  expect(subagents(h).map(({ name, role }) => ({ name, role }))).toEqual([
    { name: "Count lines in src files", role: "general-purpose" },
  ]);
  const call = h
    .items()
    .find((item) => item.type === "tool_call" && item.call.kind === "agent.spawn");
  expect(call?.type === "tool_call" && call.call.detail).toMatchObject({
    kind: "agent.spawn",
    description: "Count lines in src files",
    agentType: "general-purpose",
  });
});

test("background Agent-tool subagents are each named by their own description", () => {
  const h = harness();
  h.init();
  launch(h, "a", "Swift engine core + speed", true);
  launch(h, "b", "Swift actions + input features", true);
  launch(h, "c", "TS client pool, schemas, policy, docs", true);
  h.result();
  expect(subagents(h).map((agent) => [agent.name, agent.background])).toEqual([
    ["Swift engine core + speed", true],
    ["Swift actions + input features", true],
    ["TS client pool, schemas, policy, docs", true],
  ]);
});

test("a subagent resumed after it settled keeps the name it started with", () => {
  const h = harness();
  h.init();
  launch(h, "launch", "Fix stale lease", true);
  h.system("task_notification", {
    task_id: "task-launch",
    tool_use_id: "launch",
    status: "failed",
  });
  h.tool("resume", "SendMessage", { to: "task-launch", message: "Resume." });
  h.system("task_started", {
    task_id: "task-launch",
    tool_use_id: "resume",
    task_type: "local_agent",
    is_backgrounded: true,
  });
  expect(subagents(h).map((agent) => agent.name)).toEqual(["Fix stale lease"]);
});

test("a subagent whose task has no description is left unnamed rather than blank", () => {
  const h = harness();
  h.init();
  h.tool("launch", "Agent", { prompt: "Look around" });
  h.system("task_started", { task_id: "t", tool_use_id: "launch", task_type: "local_agent" });
  expect(subagents(h).map(({ name, role }) => ({ name, role }))).toEqual([
    { name: undefined, role: undefined },
  ]);
});
