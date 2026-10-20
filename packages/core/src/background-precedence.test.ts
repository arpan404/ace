import { expect, it } from "vitest";
import { harness } from "./test-helper.ts";

it("active background descendants keep the thread working above retry and shell waits", () => {
  const h = harness();
  h.see();
  h.start();
  h.see("child", "root", true);
  h.start("child");
  h.see("grandchild", "child");
  h.start("grandchild");
  h.shell();
  h.background();
  h.end("child");
  h.end();
  expect(h.agent("root")?.status).toMatchObject({ state: "blocked", on: "background_task" });
  expect(h.agent("child")?.status).toMatchObject({ state: "blocked", on: "background_task" });
  expect(h.agent("grandchild")?.status.state).toBe("working");
  expect(h.view.status).toEqual({ state: "working", agents: 1 });

  h.send({ type: "retry", agent: "root", on: "upstream" });
  expect(h.view.status).toEqual({ state: "working", agents: 1 });
  h.question("approval", "grandchild");
  expect(h.view.status).toEqual({ state: "needs_you", interactions: 1 });
  h.send({ type: "interaction.closed", interaction: "approval", state: "resolved" });
  expect(h.view.status).toEqual({ state: "working", agents: 1 });

  h.end("grandchild");
  expect(h.view.status).toEqual({ state: "waiting", on: "upstream" });
  h.send({ type: "retry.cleared", agent: "root" });
  expect(h.view.status).toEqual({ state: "waiting", on: "background_task" });
  h.send({
    type: "item.upsert",
    agent: "root",
    item: "shell",
    draft: { type: "tool_call", complete: true, call: { status: "succeeded" } },
  });
  h.send({ type: "background.ended", task: "task", status: "completed" });
  expect(h.view.status).toEqual({ state: "done" });
});

const rejected = (h: ReturnType<typeof harness>) =>
  Object.values(h.view.items).filter(
    (item) => item.type === "notice" && item.raw.some((raw) => raw.type === "core.rejected_fact"),
  );
const announce = (agent: string, item?: string) => ({
  type: "background.started",
  agent,
  task: "task",
  kind: "shell",
  title: "Watch CI",
  stoppable: true,
  ...(item === undefined ? {} : { item }),
});

it("a background task re-announced by the subagent that owns it moves there and stays running", () => {
  const h = harness();
  h.see();
  h.start();
  h.see("child", "root", true);
  h.start("child");
  h.shell("watch", "child");
  // Listed before the adapter knew which agent spawned it.
  h.send(announce("root"));
  for (let round = 0; round < 5; round++) h.send(announce("child", "watch"));
  expect(rejected(h)).toEqual([]);
  expect(h.task("task")).toMatchObject({
    status: "running",
    agentId: h.agent("child")?.id,
    toolCallId: h.item("watch")?.id,
  });
  expect(h.item("watch")).toMatchObject({ call: { backgroundTaskId: h.task("task")?.id } });
  h.end("child");
  h.end();
  expect(h.agent("child")?.status).toMatchObject({ state: "blocked", on: "background_task" });
  expect(h.view.status).toEqual({ state: "waiting", on: "background_task" });
});

it("a running background task cannot move to a sibling or back to an ancestor", () => {
  const h = harness();
  h.see();
  h.start();
  h.see("one", "root");
  h.see("two", "root");
  h.send(announce("one"));
  h.send(announce("two"));
  h.send(announce("root"));
  expect(rejected(h).map((notice) => notice.type === "notice" && notice.text)).toEqual([
    "Ignored adapter fact: live key has a different owner (2 times)",
  ]);
  expect(h.task("task")).toMatchObject({ status: "running", agentId: h.agent("one")?.id });
});
