import { expect, test } from "vitest";
import { unboundGraceMs } from "./pending-transcripts.ts";
import { harness } from "./translator.test-helper.ts";

type Harness = ReturnType<typeof harness>;

const placeholders = (h: Harness) =>
  Object.entries(h.state.tasks)
    .filter(([key]) => key.includes(":unbound:"))
    .map(([, task]) => task);
const childSays = (h: Harness, spawn: string, id: string, text: string, agent?: string) =>
  h.send({
    type: "assistant",
    parent_tool_use_id: spawn,
    ...(agent ? { agent_id: agent } : {}),
    message: { id, content: [{ type: "text", text }] },
  });
const textsOf = (h: Harness, agentId: string | undefined) =>
  h
    .items()
    .filter((item) => item.type === "message" && item.role === "assistant")
    .filter((item) => item.agentId === agentId)
    .flatMap((item) => (item.type === "message" ? item.parts : []))
    .map((part) => (part.type === "text" ? part.text : ""));

/**
 * Claude Code 2.1.30x: a background agent launched in one CLI process, resumed with SendMessage
 * after the process was replaced. The resumed run registers under the SendMessage call, while
 * its frames still name the original Agent call and carry the task id as `agent_id`.
 */
function resumedInNextProcess(order: "frames first" | "registration first") {
  const h = harness();
  h.send({ type: "process.started", session_id: "s", process_id: "p1" }, "lifecycle", "note");
  h.init();
  h.tool("launch", "Agent", { description: "Fix lease", run_in_background: true });
  h.system("task_started", {
    task_id: "a1",
    tool_use_id: "launch",
    task_type: "local_agent",
    is_backgrounded: true,
    description: "Fix lease",
  });
  h.result();
  h.send({ type: "process.exited", deliberate: true }, "lifecycle", "note");
  h.send({ type: "process.started", session_id: "s", process_id: "p2" }, "lifecycle", "note");
  h.init();
  h.tool("resume", "SendMessage", { to: "a1", message: "Resume where you stopped." });
  const register = () =>
    h.system("task_started", {
      task_id: "a1",
      run_id: "run-2",
      tool_use_id: "resume",
      task_type: "local_agent",
      is_backgrounded: true,
      description: "Fix lease",
    });
  if (order === "registration first") register();
  childSays(h, "launch", "m1", "Picking up the lease fix.", "a1");
  if (order === "frames first") register();
  childSays(h, "launch", "m2", "Lease fix pushed.", "a1");
  return h;
}

for (const order of ["frames first", "registration first"] as const)
  test(`a child resumed in a later process takes its frames and leaves no placeholder (${order})`, () => {
    const h = resumedInNextProcess(order);
    const resumed = Object.values(h.state.agents).find(
      (record) => record.agent.native.nativeId === "a1" && record.agent.status.state === "working",
    );
    expect(resumed).toBeDefined();
    expect(textsOf(h, resumed?.agent.id)).toEqual([
      "Picking up the lease fix.",
      "Lease fix pushed.",
    ]);
    expect(textsOf(h, h.state.agents["root"]?.agent.id)).toEqual([]);
    expect(placeholders(h).every((task) => task.status !== "running")).toBe(true);

    h.result();
    h.system("task_notification", { task_id: "a1", tool_use_id: "resume", status: "completed" });
    h.result({ origin: { kind: "task-notification" } });
    h.tick(60_000);
    expect(h.state.status.state).toBe("done");
  });

test("an unregistered child stops holding the thread when its spawning call returns", () => {
  const h = harness();
  h.init();
  h.tool("launch", "Agent", { description: "Count lines" });
  childSays(h, "launch", "m1", "Counting.");
  expect(placeholders(h).map((task) => task.status)).toEqual(["running"]);
  h.send({
    type: "user",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: "launch", content: "42 lines" }] },
  });
  expect(placeholders(h).map((task) => task.status)).toEqual(["stopped"]);
  h.result();
  expect(h.state.status.state).toBe("done");
});

test("an unregistered child that finished releases the thread without replaying", () => {
  const h = harness();
  h.init();
  childSays(h, "launch", "m1", "Working on it.");
  h.result();
  expect(h.state.status.state).not.toBe("done");
  h.system("task_notification", { task_id: "x", tool_use_id: "launch", status: "completed" });
  expect(placeholders(h).map((task) => task.status)).toEqual(["stopped"]);
  h.tick(60_000);
  expect(h.state.status.state).toBe("done");
});

test("an unregistered child stops holding the thread once the turn ended and it went quiet", () => {
  const h = harness();
  h.init();
  childSays(h, "launch", "m1", "Still going.");
  h.result();
  expect(h.state.status.state).not.toBe("done");
  h.tick(h.deadline() ?? 0);
  expect(placeholders(h).map((task) => task.status)).toEqual(["stopped"]);
  expect(h.state.status.state).toBe("done");

  // Fresh frames are fresh evidence the child works: it holds the thread again.
  childSays(h, "launch", "m2", "One more thing.");
  expect(placeholders(h).map((task) => task.status)).toEqual(["running"]);
  expect(h.state.status.state).not.toBe("done");
  h.tick(h.deadline() ?? 0);
  expect(h.state.status.state).toBe("done");
});

test("a child that registers within the grace period still receives its frames", () => {
  const h = harness();
  h.init();
  childSays(h, "launch", "m1", "Early words.");
  h.result();
  h.tick(1_000 + unboundGraceMs / 2);
  h.system("task_started", { task_id: "C", tool_use_id: "launch", task_type: "local_agent" });
  const child = Object.values(h.state.agents).find((r) => r.agent.native.nativeId === "C");
  expect(textsOf(h, child?.agent.id)).toEqual(["Early words."]);
  expect(placeholders(h).map((task) => task.status)).toEqual(["completed"]);
});

for (const exit of ["process.exited", "process.started"])
  test(`every unregistered child placeholder ends when the provider session goes away (${exit})`, () => {
    const h = harness();
    h.init();
    h.tool("launch", "Agent");
    childSays(h, "launch", "m1", "Working.");
    childSays(h, "other", "m2", "Also working.");
    expect(placeholders(h).map((task) => task.status)).toEqual(["running", "running"]);
    if (exit === "process.exited")
      h.send({ type: "process.exited", deliberate: true }, "lifecycle", "note");
    else
      h.send({ type: "process.started", session_id: "s", process_id: "p2" }, "lifecycle", "note");
    expect(placeholders(h).map((task) => task.status)).toEqual(["stopped", "stopped"]);
  });
