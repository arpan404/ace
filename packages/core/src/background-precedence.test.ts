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
  h.send({ type: "interaction.resolved", interaction: "approval" });
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
