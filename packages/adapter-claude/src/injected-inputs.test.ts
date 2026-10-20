import { expect, test } from "vitest";
import { harness } from "./translator.test-helper.ts";

// Shapes follow Claude Code sessions stored by ace: a background subagent runs its own
// background command, and Claude writes the command's completion into the subagent as a user
// message; a coordinator's SendMessage reaches a running fork as `<agent-message>`.
const child = "claude:s:child:launch";

function backgroundChild() {
  const h = harness();
  h.init();
  h.tool("launch", "Agent", { description: "Diagnose crashes", run_in_background: true });
  h.system("task_started", {
    task_id: "ae80",
    tool_use_id: "launch",
    task_type: "local_agent",
    is_backgrounded: true,
    description: "Diagnose crashes",
    prompt: "Diagnose the crash loop",
  });
  h.result();
  // Claude echoes the subagent's task prompt as its first user message.
  childReceives(h, "u0", "Diagnose the crash loop");
  return h;
}
function childReceives(h: ReturnType<typeof harness>, uuid: string, content: string) {
  h.send({
    type: "user",
    parent_tool_use_id: "launch",
    uuid,
    message: { role: "user", content },
  });
}
function childStarts(h: ReturnType<typeof harness>, task: string, type: string) {
  h.send({
    type: "assistant",
    parent_tool_use_id: "launch",
    message: { id: `m:${task}`, content: [{ type: "tool_use", id: `t:${task}`, name: "Bash" }] },
  });
  h.system("task_started", {
    task_id: task,
    tool_use_id: `t:${task}`,
    task_type: type,
    is_backgrounded: true,
    description: "bun run check:deps",
  });
}
const notification = (task: string, summary: string) =>
  `<task-notification>\n<task-id>${task}</task-id>\n<tool-use-id>toolu_016rxuJ1ZNE6um6CJqDM6LZJ</tool-use-id>\n<output-file>/private/tmp/claude-501/tasks/${task}.output</output-file>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`;
const childMessages = (h: ReturnType<typeof harness>) =>
  h
    .items()
    .filter(
      (item) =>
        item.type === "message" &&
        item.role === "user" &&
        h.state.agents[child]?.agent.id === item.agentId,
    );

test("a background command's notification inside a subagent is a background-completion input", () => {
  const h = backgroundChild();
  childStarts(h, "b3m9", "local_bash");
  const text = notification(
    "b3m9",
    'Background command "bun run check:deps" completed (exit code 0)',
  );
  childReceives(h, "u1", text);
  expect(childMessages(h)).toEqual([
    expect.objectContaining({ parts: [{ type: "text", text: "Diagnose the crash loop" }] }),
    expect.objectContaining({
      synthetic: true,
      origin: { kind: "background_completion" },
      parts: [{ type: "text", text }],
    }),
  ]);
});

test("a nested agent's notification inside a subagent is a subagent-result input", () => {
  const h = backgroundChild();
  childStarts(h, "a77f", "local_agent");
  childReceives(h, "u1", notification("a77f", 'Agent "Check the lockfile" completed'));
  expect(childMessages(h).at(-1)).toMatchObject({
    synthetic: true,
    origin: { kind: "subagent_result" },
  });
});

test("a notification for a task this process never saw is still classified from its summary", () => {
  const h = backgroundChild();
  childReceives(
    h,
    "u1",
    notification("bzzz", 'Background command "git diff" failed with exit code 1'),
  );
  expect(childMessages(h).at(-1)).toMatchObject({ origin: { kind: "background_completion" } });
});

test("another agent's message to a running subagent is input from that agent, kept beside its prompt", () => {
  const h = backgroundChild();
  const text =
    '<agent-message from="a922a04248ae74488">\nFYI: my Swift now compiles. Keep working on top.\n</agent-message>';
  childReceives(h, "u1", text);
  expect(childMessages(h)).toEqual([
    expect.objectContaining({ parts: [{ type: "text", text: "Diagnose the crash loop" }] }),
    expect.objectContaining({ synthetic: true, origin: { kind: "parent_agent" } }),
  ]);
});

test("a subagent's ordinary user text stays its prompt", () => {
  const h = backgroundChild();
  childReceives(h, "u1", "Please also check <task-notification> handling");
  const messages = childMessages(h);
  expect(messages).toHaveLength(1);
  expect(messages[0]).not.toHaveProperty("origin");
});
