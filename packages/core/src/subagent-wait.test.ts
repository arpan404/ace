import { expect, test } from "vitest";
import { harness } from "./test-helper.ts";
function waiting() {
  const h = harness();
  h.see();
  h.start();
  for (const child of ["one", "two"]) {
    h.see(child, "root");
    h.start(child);
  }
  h.send({
    type: "item.upsert",
    agent: "root",
    item: "wait",
    draft: {
      type: "tool_call",
      call: {
        kind: "agent.message",
        status: "running",
        detail: { kind: "agent.message", message: "wait" },
      },
    },
  });
  return h;
}
test("native waiting targets only selected live children and human input takes precedence", () => {
  const h = waiting();
  h.send({ type: "subagents.waiting", agent: "root", item: "wait", targets: ["one"] });
  expect(h.agent("root")?.status).toEqual({
    state: "blocked",
    on: "subagents",
    refs: [h.agent("one")?.id],
  });
  h.question();
  expect(h.agent("root")?.status).toMatchObject({ state: "blocked", on: "human" });
  h.send({ type: "interaction.closed", interaction: "question", state: "resolved" });
  h.end("one");
  expect(h.agent("root")?.status).toEqual({ state: "blocked", on: "subagents", refs: [] });
  h.send({
    type: "item.upsert",
    agent: "root",
    item: "wait",
    draft: { type: "tool_call", complete: true, call: { status: "succeeded" } },
  });
  expect(h.agent("root")?.status.state).toBe("working");
});
test("waiting facts reject missing tools, foreign ownership and malformed target keys", () => {
  const h = waiting();
  const fact = { type: "subagents.waiting", agent: "root", item: "wait", targets: [] };
  for (const invalid of [
    { ...fact, item: "missing" },
    { ...fact, agent: "one" },
    { ...fact, targets: [42] },
  ])
    h.send(invalid);
  expect(h.agent("root")?.status.state).toBe("working");
  expect(
    Object.values(h.view.items).filter(
      (i) => i.type === "notice" && i.raw.some((r) => r.type === "core.rejected_fact"),
    ),
  ).toHaveLength(3);
});
test("a wait from an ended turn cannot block a newer active turn", () => {
  const h = waiting();
  h.send({ type: "subagents.waiting", agent: "root", item: "wait", targets: [] });
  h.end();
  h.start("root", "new-turn");
  expect(h.agent("root")?.status.state).toBe("working");
});
