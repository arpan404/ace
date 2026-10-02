import { expect, it } from "vitest";
import { nextDeadline } from "./index.ts";
import { harness } from "./test-helper.ts";

it.each(["agent", "transport"] as const)(
  "late completed-child text revives silent ancestors in %s mode",
  (liveness) => {
    const h = harness("codex", { silenceMs: 10, liveness });
    h.start();
    h.see("middle", "root");
    h.start("middle");
    h.see("child", "middle");
    h.start("child");
    h.send({ type: "item.delta", agent: "child", item: "answer", field: "text", append: "before" });
    h.end("child");
    h.end("middle");
    h.send({ type: "tick" }, 200);
    expect(h.agent("root")?.status.state).toBe("unresponsive");
    const events = h.send(
      { type: "item.delta", agent: "child", item: "answer", field: "text", append: " after" },
      201,
    );
    expect(events).toContainEqual({
      type: "agent.status",
      agentId: h.agent("root")?.id,
      status: { state: "working", activity: "starting_turn" },
    });
    expect(events).toContainEqual({
      type: "thread.updated",
      status: { state: "working", agents: 1 },
    });
    expect(nextDeadline(h.state)).toBe(212);
  },
);

it("late text on an idle sibling restores other agents after transport silence", () => {
  const h = harness("codex", { silenceMs: 10, liveness: "transport" });
  h.start();
  h.see("quiet", "root");
  h.start("quiet");
  h.see("idle", "root");
  h.start("idle");
  h.send({ type: "item.delta", agent: "idle", item: "answer", field: "text", append: "before" });
  h.end("idle");
  h.send({ type: "tick" }, 200);
  expect(h.agent("quiet")?.status.state).toBe("unresponsive");
  const events = h.send(
    { type: "item.delta", agent: "idle", item: "answer", field: "text", append: " after" },
    201,
  );
  expect(events).toContainEqual({
    type: "agent.status",
    agentId: h.agent("quiet")?.id,
    status: { state: "working", activity: "starting_turn" },
  });
  expect(events).toContainEqual({
    type: "thread.updated",
    status: { state: "working", agents: 2 },
  });
});

it("transport recovery revives a sibling even when its ancestors remain settled after restart", () => {
  const h = harness("codex", { silenceMs: 10, liveness: "transport" });
  h.see();
  h.send({ type: "process.exited", deliberate: false });
  h.send({ type: "process.started" });
  h.see("quiet", "root");
  h.start("quiet");
  h.see("idle", "root");
  h.start("idle");
  h.send({ type: "item.delta", agent: "idle", item: "answer", field: "text", append: "before" });
  h.end("idle");
  h.send({ type: "tick" }, 200);
  expect(h.agent("root")?.status.state).toBe("failed");
  expect(h.agent("quiet")?.status.state).toBe("unresponsive");
  expect(h.agent("idle")?.status.state).toBe("idle");
  const events = h.send(
    { type: "item.delta", agent: "idle", item: "answer", field: "text", append: " after" },
    201,
  );
  expect(events).toContainEqual({
    type: "agent.status",
    agentId: h.agent("quiet")?.id,
    status: { state: "working", activity: "starting_turn" },
  });
  expect(events).toContainEqual({
    type: "thread.updated",
    status: { state: "working", agents: 1 },
  });
  expect(nextDeadline(h.state)).toBe(212);
});

it("late child output revives a non-root ancestor while the root keeps running its own shell", () => {
  const h = harness("codex", { silenceMs: 10 });
  h.start();
  h.shell("root-shell");
  h.see("middle", "root");
  h.start("middle");
  h.see("idle", "middle");
  h.start("idle");
  h.see("child", "idle");
  h.start("child");
  h.send({ type: "item.delta", agent: "child", item: "answer", field: "text", append: "before" });
  h.end("child");
  h.end("idle");
  h.send({ type: "tick" }, 200);
  const rootStatus = { state: "working", activity: "tool", itemId: h.item("root-shell")?.id };
  expect(h.agent("root")?.status).toEqual(rootStatus);
  expect(h.agent("middle")?.status.state).toBe("unresponsive");
  expect(h.agent("idle")?.status.state).toBe("idle");
  const events = h.send(
    { type: "item.delta", agent: "child", item: "answer", field: "text", append: " after" },
    201,
  );
  expect(events).toContainEqual({
    type: "agent.status",
    agentId: h.agent("middle")?.id,
    status: { state: "working", activity: "starting_turn" },
  });
  expect(events).toContainEqual({
    type: "thread.updated",
    status: { state: "working", agents: 2 },
  });
  expect(h.agent("root")?.status).toEqual(rootStatus);
  expect(nextDeadline(h.state)).toBe(212);
});
