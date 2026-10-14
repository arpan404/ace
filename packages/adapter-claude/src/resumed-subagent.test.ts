import { expect, test } from "vitest";
import { harness } from "./translator.test-helper.ts";

// Frame shapes follow a real Claude Code 2.1.296 session: a background agent stopped on the
// five-hour session limit, then the coordinator resumed it with SendMessage. Claude reports the
// resumed run as another `task_started` for the same task id, with a new `run_id` and the
// SendMessage call as its `tool_use_id`.
const child = "claude:s:child:launch";
const limitText = "You've hit your session limit · resets 8:30pm (America/Chicago)";

function stoppedOnLimit(runId?: string) {
  const h = harness();
  h.init();
  h.tool("launch", "Agent", { description: "Fix stale lease", run_in_background: true });
  h.system("task_started", {
    task_id: "a904",
    ...(runId === undefined ? {} : { run_id: runId }),
    tool_use_id: "launch",
    task_type: "local_agent",
    is_backgrounded: true,
    description: "Fix stale lease",
    prompt: "Fix the stale lease",
  });
  h.result();
  childSays(h, "launch", "m1", "Adding retainedFailure to failure-copy.ts.");
  childSays(h, "launch", "m2", limitText);
  h.system("task_updated", {
    task_id: "a904",
    ...(runId === undefined ? {} : { run_id: runId }),
    patch: { status: "failed", error: limitText },
  });
  h.system("task_notification", {
    task_id: "a904",
    tool_use_id: "launch",
    status: "failed",
    summary: `Agent "Fix stale lease" failed: ${limitText}`,
  });
  // The notification's wake grace passes without the coordinator answering.
  h.tick(10_000);
  return h;
}
function childSays(h: ReturnType<typeof harness>, parent: string, id: string, text: string) {
  h.send({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { id, content: [{ type: "text", text }] },
  });
}
function childRuns(h: ReturnType<typeof harness>, parent: string, toolId: string) {
  h.send({
    type: "assistant",
    parent_tool_use_id: parent,
    message: {
      id: `m:${toolId}`,
      content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command: "git status" } }],
    },
  });
}
function resume(h: ReturnType<typeof harness>, runId?: string) {
  h.tool("resume", "SendMessage", { to: "a904", message: "Resume: the limit has reset." });
  h.system("task_started", {
    task_id: "a904",
    ...(runId === undefined ? {} : { run_id: runId }),
    tool_use_id: "resume",
    task_type: "local_agent",
    is_backgrounded: true,
    description: "Fix stale lease",
  });
}
const childStatus = (h: ReturnType<typeof harness>) => h.state.agents[child]?.agent.status.state;
const shell = (h: ReturnType<typeof harness>) =>
  h.items().find((item) => item.type === "tool_call" && item.call.kind === "shell");

for (const shape of ["with run ids", "without run ids"]) {
  const run = (id: string) => (shape === "with run ids" ? id : undefined);

  test(`a subagent resumed after a session limit works again and settles on its new outcome (${shape})`, () => {
    const h = stoppedOnLimit(run("run-1"));
    expect(childStatus(h)).toBe("failed");
    expect(h.state.status.state).toBe("failed");

    resume(h, run("run-2"));
    expect(childStatus(h)).toBe("working");
    h.result();
    expect(childStatus(h)).toBe("working");
    expect(h.state.status.state).not.toBe("done");
    expect(h.state.status.state).not.toBe("failed");

    childRuns(h, "resume", "after-resume");
    childSays(h, "resume", "m3", "Added retainedFailure; checks pass.");
    expect(shell(h)).toMatchObject({ complete: false, call: { status: "running" } });
    expect(childStatus(h)).toBe("working");
    const texts = h
      .items()
      .filter((item) => item.type === "message" && item.agentId === h.state.agents[child]?.agent.id)
      .flatMap((item) => (item.type === "message" ? item.parts : []))
      .map((part) => (part.type === "text" ? part.text : ""));
    expect(texts).toEqual([
      "Fix the stale lease",
      "Adding retainedFailure to failure-copy.ts.",
      limitText,
      "Added retainedFailure; checks pass.",
    ]);

    h.system("task_updated", {
      task_id: "a904",
      ...(run("run-2") === undefined ? {} : { run_id: "run-2" }),
      patch: { status: "completed" },
    });
    h.system("task_notification", { task_id: "a904", tool_use_id: "resume", status: "completed" });
    expect(childStatus(h)).toBe("idle");
    // The coordinator wakes on the notification and reports.
    h.send({
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: "report", content: [{ type: "text", text: "The lease fix is done." }] },
    });
    h.result();
    h.tick(20_000);
    expect(h.state.status.state).toBe("done");
  });
}

test("the resumed subagent keeps the agent and spawn link of its first run", () => {
  const h = stoppedOnLimit("run-1");
  const before = h.state.agents[child]?.agent;
  resume(h, "run-2");
  const after = h.state.agents[child]?.agent;
  expect(after?.status.state).toBe("working");
  expect(Object.values(h.state.agents).filter((record) => record.agent.parentId)).toHaveLength(1);
  expect(after?.id).toBe(before?.id);
  expect(after?.spawnedBy).toBe(before?.spawnedBy);
});

test("a repeated start of the run that already failed does not revive the subagent", () => {
  const h = stoppedOnLimit("run-1");
  h.system("task_started", {
    task_id: "a904",
    run_id: "run-1",
    tool_use_id: "launch",
    task_type: "local_agent",
    is_backgrounded: true,
  });
  expect(childStatus(h)).toBe("failed");
  expect(h.state.status.state).toBe("failed");
});

test("a late update of the failed run cannot settle the resumed run", () => {
  const h = stoppedOnLimit("run-1");
  resume(h, "run-2");
  h.system("task_updated", { task_id: "a904", run_id: "run-1", patch: { status: "failed" } });
  expect(childStatus(h)).toBe("working");
  h.result();
  expect(h.state.status.state).not.toBe("done");
  expect(h.state.status.state).not.toBe("failed");
});

test("a resumed subagent that vanishes from the running tasks settles instead of working forever", () => {
  const h = stoppedOnLimit("run-1");
  resume(h, "run-2");
  h.system("background_tasks_changed", {
    tasks: [{ task_id: "a904", task_type: "local_agent", description: "Fix stale lease" }],
  });
  h.result();
  expect(childStatus(h)).toBe("working");
  h.send({ type: "system", subtype: "background_tasks_changed", tasks: [] }, "sdk", "recv", 20_000);
  h.tick(21_000);
  expect(childStatus(h)).not.toBe("working");
  h.tick(30_000);
  expect(h.state.status.state).not.toBe("working");
});
