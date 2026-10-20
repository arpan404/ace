import { expect, test } from "vitest";
import { harness } from "./translator.test-helper.ts";

// Shapes follow Claude Code sessions stored by ace: after reading a screenshot Claude writes a
// scale note for the model as a user message marked `isSynthetic`; after the person stops a
// tool it writes an interruption marker.
const imageNote =
  "[Image: original 1206x2622, displayed at 920x2000. Multiply coordinates by 1.31 to map to original image.]";
const child = "claude:s:child:launch";

const userMessages = (h: ReturnType<typeof harness>) =>
  h.items().filter((item) => item.type === "message" && item.role === "user");

test("Claude's scale note for an image is a synthetic message, not the person's or a wake input", () => {
  const h = harness();
  h.init();
  h.send({
    type: "user",
    uuid: "note",
    isSynthetic: true,
    message: { role: "user", content: [{ type: "text", text: imageNote }] },
  });
  const [note] = userMessages(h);
  expect(note).toMatchObject({ synthetic: true, parts: [{ type: "text", text: imageNote }] });
  expect(note).not.toHaveProperty("origin");
});

test("a scale note inside a subagent keeps the subagent's task prompt", () => {
  const h = harness();
  h.init();
  h.tool("launch", "Agent", { description: "Check screens", run_in_background: true });
  h.system("task_started", {
    task_id: "ae80",
    tool_use_id: "launch",
    task_type: "local_agent",
    is_backgrounded: true,
    description: "Check screens",
    prompt: "Check the pairing screens",
  });
  h.send({
    type: "user",
    parent_tool_use_id: "launch",
    uuid: "note",
    isSynthetic: true,
    message: { role: "user", content: [{ type: "text", text: imageNote }] },
  });
  const childMessages = userMessages(h).filter(
    (item) => item.agentId === h.state.agents[child]?.agent.id,
  );
  expect(childMessages.map((item) => item.type === "message" && item.parts)).toEqual([
    [{ type: "text", text: "Check the pairing screens" }],
    [{ type: "text", text: imageNote }],
  ]);
});

test("the marker for a stopped tool is a notice, not a message the person typed", () => {
  const h = harness();
  h.init();
  h.send({
    type: "user",
    uuid: "stop",
    message: {
      role: "user",
      content: [{ type: "text", text: "[Request interrupted by user for tool use]" }],
    },
  });
  expect(userMessages(h)).toEqual([]);
  expect(h.items()).toContainEqual(
    expect.objectContaining({ type: "notice", text: "[Request interrupted by user for tool use]" }),
  );
});
