import { expect, test } from "vitest";
import { harness } from "./translator.test-helper.ts";

// Claude Code 2.1.286 lists a new background task in `background_tasks_changed` (without its
// `tool_use_id`) just before the `task_started` that names the spawning tool, and lists every
// live task again each time the set changes. See fixtures/claude/2.1.286/background-shell.jsonl.
const child = "claude:s:child:launch";
const agentTask = { task_id: "agent", task_type: "local_agent", description: "Fix side PRs" };
const shellTask = { task_id: "shell", task_type: "local_bash", description: "Watch CI" };

function subagentWithBackgroundShell() {
  const h = harness();
  h.init();
  h.tool("launch", "Agent", { description: "Fix side PRs", run_in_background: true });
  h.system("background_tasks_changed", { tasks: [agentTask] });
  h.system("task_started", {
    task_id: "agent",
    tool_use_id: "launch",
    task_type: "local_agent",
    is_backgrounded: true,
    description: "Fix side PRs",
    prompt: "Fix the side PRs",
  });
  h.result();
  h.send({
    type: "assistant",
    parent_tool_use_id: "launch",
    message: {
      id: "m:watch",
      content: [
        {
          type: "tool_use",
          id: "watch",
          name: "Bash",
          input: { command: "gh pr checks --watch", run_in_background: true },
        },
      ],
    },
  });
  h.system("background_tasks_changed", { tasks: [agentTask, shellTask] });
  h.system("task_started", {
    task_id: "shell",
    tool_use_id: "watch",
    task_type: "local_bash",
    is_backgrounded: true,
    description: "Watch CI",
  });
  return h;
}
const rejections = (h: ReturnType<typeof harness>) =>
  h
    .items()
    .filter((item) => item.type === "notice" && item.text.startsWith("Ignored adapter fact"));
const shellOwner = (h: ReturnType<typeof harness>) =>
  Object.values(h.state.tasks).find((task) => task.title === "Watch CI");

test("a subagent's background shell listed before it starts belongs to the subagent without warnings", () => {
  const h = subagentWithBackgroundShell();
  for (let round = 0; round < 5; round++)
    h.system("background_tasks_changed", { tasks: [agentTask, shellTask] });
  expect(rejections(h)).toEqual([]);
  expect(shellOwner(h)).toMatchObject({
    status: "running",
    agentId: h.state.agents[child]?.agent.id,
  });
});

test("a subagent stays busy while its background shell runs after its own task ends", () => {
  const h = subagentWithBackgroundShell();
  h.system("task_updated", { task_id: "agent", patch: { status: "completed" } });
  h.system("background_tasks_changed", { tasks: [shellTask] });
  expect(h.state.agents[child]?.agent.status).toMatchObject({
    state: "blocked",
    on: "background_task",
  });
  expect(h.state.status.state).not.toBe("done");
  h.system("background_tasks_changed", { tasks: [] });
  h.system("task_updated", { task_id: "shell", patch: { status: "completed" } });
  expect(rejections(h)).toEqual([]);
  expect(h.state.agents[child]?.agent.status.state).not.toBe("blocked");
});
