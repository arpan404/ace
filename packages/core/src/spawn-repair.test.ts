import { it, expect } from "vitest";
import { harness } from "./test-helper.ts";
it("reparenting clears the old spawning link in state and client events until a replacement arrives", () => {
  const h = harness("cursor");
  h.see();
  h.see("leaf", "root");
  h.see("branch", "root");
  h.send({
    type: "item.upsert",
    agent: "root",
    item: "old",
    draft: {
      type: "tool_call",
      call: {
        kind: "agent.spawn",
        title: "Original spawn",
        status: "running",
        detail: { kind: "agent.spawn", childAgent: "leaf" },
      },
    },
  });
  expect(h.agent("leaf")?.spawnedBy).toBe(h.item("old")?.id);
  const events = h.send({ type: "agent.linked", agent: "leaf", parent: "branch" });
  expect(h.agent("leaf")).toMatchObject({ parentId: h.agent("branch")?.id, spawnedBy: null });
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "agent.updated",
      agentId: h.agent("leaf")?.id,
      spawnedBy: null,
    }),
  );
  h.send({
    type: "item.upsert",
    agent: "root",
    item: "old",
    draft: { type: "tool_call", call: { status: "succeeded" } },
  });
  expect(h.agent("leaf")).toMatchObject({ parentId: h.agent("branch")?.id, spawnedBy: null });
  h.send({
    type: "item.upsert",
    agent: "branch",
    item: "replacement",
    draft: {
      type: "tool_call",
      call: {
        kind: "agent.spawn",
        title: "Replacement spawn",
        status: "running",
        detail: { kind: "agent.spawn", childAgent: "leaf" },
      },
    },
  });
  expect(h.agent("leaf")).toMatchObject({
    parentId: h.agent("branch")?.id,
    spawnedBy: h.item("replacement")?.id,
  });
});
it("an old pending spawning item cannot reclaim a child after authoritative reparenting", () => {
  const h = harness("cursor");
  h.see();
  h.see("leaf", "root");
  h.see("branch", "root");
  h.send({ type: "agent.linked", agent: "leaf", parent: "root", spawnedBy: "late-old" });
  h.send({ type: "agent.linked", agent: "leaf", parent: "branch" });
  h.send({
    type: "item.upsert",
    agent: "root",
    item: "late-old",
    draft: {
      type: "tool_call",
      call: {
        kind: "agent.spawn",
        title: "Late old spawn",
        status: "running",
        detail: { kind: "agent.spawn" },
      },
    },
  });
  expect(h.agent("leaf")).toMatchObject({ parentId: h.agent("branch")?.id, spawnedBy: null });
});
