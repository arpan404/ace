import { describe, expect, it } from "vitest";
import type { Fact } from "./index.ts";
import { harness } from "./test-helper.ts";

describe("lenient fact rejection", () => {
  it("invalid input for an unseen agent emits a warning without publishing a phantom agent", () => {
    const h = harness();
    h.see();
    const before = structuredClone(h.state);
    const fact: Fact = {
      type: "item.upsert",
      agent: "unseen",
      item: "broken",
      draft: {
        type: "tool_call",
        call: { kind: "shell", detail: { kind: "shell" } },
      },
    };
    const events = h.send(fact);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "item.created",
      item: {
        type: "notice",
        level: "warning",
        raw: [{ type: "core.rejected_fact", data: fact }],
      },
    });
    const after = structuredClone(h.state);
    // Rejection can persist its diagnostic, but must not change existing engine state.
    after.items = before.items;
    expect(after).toEqual(before);
  });

  it("an incompatible delta is retained as a warning and leaves the message unchanged", () => {
    const h = harness();
    h.see();
    h.start();
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "message",
      draft: {
        type: "message",
        parts: [{ type: "text", text: "Original" }],
      },
    });
    const events = h.send({
      type: "item.delta",
      agent: "root",
      item: "message",
      field: "output",
      append: "Wrong field",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "item.created",
      item: { type: "notice", level: "warning" },
    });
    expect(h.item("message")).toMatchObject({ parts: [{ type: "text", text: "Original" }] });
  });

  it("a cyclic relationship produces a warning and retains the published parent", () => {
    const h = harness();
    h.see();
    h.send({ type: "agent.linked", agent: "child", parent: "root" });
    const before = structuredClone(h.state);
    const events = h.send({ type: "agent.linked", agent: "root", parent: "child" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "item.created",
      item: { type: "notice", level: "warning" },
    });
    const after = structuredClone(h.state);
    after.items = before.items;
    expect(after).toEqual(before);
  });

  it("rejecting an invalid notice update retains the client's original item and emits a separate warning", () => {
    const h = harness();
    h.see();
    h.start();
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "notice",
      draft: { type: "notice", level: "info", text: "Original" },
    });
    const original = structuredClone(h.item("notice"));
    const events = h.send({
      type: "item.upsert",
      agent: "root",
      item: "notice",
      draft: { type: "notice", level: "invalid", text: "Invalid replacement" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "item.created",
      item: { type: "notice", level: "warning" },
    });
    expect(h.item("notice")).toEqual(original);
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "notice",
      draft: { type: "notice", text: "Updated" },
    });
    expect(h.item("notice")).toMatchObject({ id: original?.id, text: "Updated" });
  });

  it("a negative usage total becomes a warning instead of an invalid protocol event", () => {
    const h = harness();
    h.see();
    const events = h.send({ type: "usage", agent: "stray", inputTokens: -1, outputTokens: 2 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "item.created",
      item: { type: "notice", level: "warning" },
    });
  });

  it.each(["interaction", "task"])(
    "a pending %s key cannot be claimed by an unseen agent",
    (kind) => {
      const h = harness();
      h.see();
      if (kind === "interaction") h.question("key");
      else h.background("key");
      const before = structuredClone(h.state);
      const fact =
        kind === "interaction"
          ? {
              type: "interaction.opened",
              agent: "stray",
              interaction: "key",
              blocking: true,
              request: { kind: "question", questions: [] },
            }
          : {
              type: "background.started",
              agent: "stray",
              task: "key",
              kind: "shell",
              title: "Other command",
              stoppable: true,
            };
      const events = h.send(fact);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "item.created",
        item: {
          type: "notice",
          level: "warning",
          raw: [{ type: "core.rejected_fact", data: fact }],
        },
      });
      const after = structuredClone(h.state);
      after.items = before.items;
      expect(after).toEqual(before);
    },
  );

  it("a question cannot be resolved with an approval answer", () => {
    const h = harness();
    h.see();
    h.question();
    const events = h.send({
      type: "interaction.closed",
      interaction: "question",
      state: "resolved",
      resolution: { kind: "approval", optionId: "allow" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "item.created",
      item: { type: "notice", level: "warning" },
    });
    expect(h.interaction("question")).toMatchObject({ state: "pending" });
    expect(h.view.status).toMatchObject({ state: "needs_you" });
  });

  it("an interaction cannot claim a transcript message as its tool call", () => {
    const h = harness();
    h.see();
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "message",
      draft: { type: "message", parts: [] },
    });
    const events = h.send({
      type: "interaction.opened",
      agent: "root",
      interaction: "bad",
      blocking: true,
      request: { kind: "question", questions: [] },
      item: "message",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "item.created",
      item: { type: "notice", level: "warning" },
    });
    expect(Object.values(h.view.interactions)).toHaveLength(0);
  });

  it.each(["child-first", "call-first"])(
    "a spawn link cannot re-parent the root when frames arrive %s",
    (order) => {
      const h = harness();
      h.see();
      h.see("child", "root");
      const link = { type: "agent.linked", agent: "root", spawnedBy: "spawn" };
      const call = {
        type: "item.upsert",
        agent: "child",
        item: "spawn",
        draft: {
          type: "tool_call",
          call: { kind: "agent.spawn", status: "running", detail: { kind: "agent.spawn" } },
        },
      };
      h.send(order === "child-first" ? link : call);
      const before = structuredClone(h.state);
      const fact = order === "child-first" ? call : link;
      const events = h.send(fact);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "item.created",
        item: {
          type: "notice",
          level: "warning",
          raw: [{ type: "core.rejected_fact", data: fact }],
        },
      });
      expect(h.agent("root")).toMatchObject({ parentId: null });
      const after = structuredClone(h.state);
      after.items = before.items;
      expect(after).toEqual(before);
    },
  );

  it.each([
    { type: "message", runId: "invented" },
    { type: "message", id: "invented" },
    { type: "message", agentId: "invented" },
    { type: "message", createdAt: 0 },
    { type: "tool_call", call: { kind: "custom", id: "invented" } },
    { type: "tool_call", call: { kind: "custom", backgroundTaskId: "invented" } },
    {
      type: "tool_call",
      call: { kind: "agent.spawn", detail: { kind: "agent.spawn", childAgentId: "invented" } },
    },
    {
      type: "tool_call",
      call: { kind: "agent.message", detail: { kind: "agent.message", targetAgentId: "invented" } },
    },
  ])("adapters cannot inject canonical identities or timestamps into $type drafts", (draft) => {
    const h = harness();
    h.see();
    const fact = { type: "item.upsert", agent: "root", item: "forged", draft };
    const events = h.send(fact);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "item.created",
      item: { type: "notice", level: "warning", raw: [{ type: "core.rejected_fact", data: fact }] },
    });
    expect(Object.values(h.view.items).every((item) => item.type === "notice")).toBe(true);
  });

  it("non-JSON raw data becomes a serializable warning instead of entering the event log", () => {
    const h = harness();
    h.see();
    const events = h.send({
      type: "interaction.opened",
      interaction: "bad",
      agent: "stray",
      blocking: true,
      request: { kind: "question", questions: [] },
      raw: [{ type: "native", data: 1n }],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "item.created",
      item: { type: "notice", level: "warning" },
    });
    expect(() => JSON.stringify(events)).not.toThrow();
    expect(() => JSON.stringify(h.state)).not.toThrow();
  });

  it.each([
    { type: "provider.future", agent: "stray", value: "retained" },
    {
      type: "agent.seen",
      agent: "stray",
      origin: "provider_subagent",
      fidelity: "full",
      cwd: "/repo",
      native: { provider: "codex", futureField: "retained" },
    },
    {
      type: "item.upsert",
      agent: "stray",
      item: "new",
      draft: { type: "message", parts: [{ type: "text", text: "hello", futureField: "retained" }] },
    },
    {
      type: "interaction.opened",
      agent: "stray",
      interaction: "new",
      blocking: true,
      request: { kind: "question", questions: [], futureField: "retained" },
    },
  ])("unknown provider fields remain visible in a warning for $type", (fact) => {
    const h = harness();
    h.see();
    const events = h.send(fact);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "item.created",
      item: { type: "notice", level: "warning", raw: [{ type: "core.rejected_fact", data: fact }] },
    });
    expect(Object.values(h.view.agents)).toHaveLength(1);
  });
});
