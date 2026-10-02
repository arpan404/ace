import { describe, expect, it } from "vitest";
import { harness } from "./test-helper.ts";

describe("requests and tasks before items", () => {
  it("background start before the native item preserves its allocated links when enriched", () => {
    const h = harness();
    h.see();
    h.start();
    h.background("job", "late-shell");
    const synthesizedId = h.item("late-shell")?.id;
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "late-shell",
      draft: {
        type: "tool_call",
        complete: false,
        call: {
          kind: "shell",
          title: "Actual shell",
          status: "running",
          detail: { kind: "shell", command: "real command" },
        },
      },
    });
    expect(h.item("late-shell")).toMatchObject({
      id: synthesizedId,
      call: { backgroundTaskId: h.task("job")?.id, detail: { command: "real command" } },
    });
    expect(h.task("job")?.toolCallId).toBe(synthesizedId);
    h.end();
    expect(h.item("late-shell")).toMatchObject({ call: { status: "running" } });
    expect(h.view.status).toEqual({ state: "waiting", on: "background_task" });
  });

  it("a request referencing an absent Codex item creates and retains its tool identity", () => {
    const h = harness();
    h.see();
    h.start();
    h.send({
      type: "interaction.opened",
      agent: "root",
      interaction: "input",
      item: "missing",
      blocking: true,
      request: { kind: "plan_review", markdown: "" },
    });
    const placeholderId = h.item("missing")?.id;
    expect(h.interaction("input")?.toolCallId).toBe(placeholderId);
    expect(h.item("missing")).toMatchObject({
      type: "tool_call",
      call: { status: "awaiting_approval" },
    });
    expect(h.view.status).toEqual({ state: "needs_you", interactions: 1 });
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "missing",
      draft: {
        type: "tool_call",
        call: { kind: "plan", title: "Plan", detail: { kind: "plan", markdown: "Plan text" } },
      },
    });
    expect(h.item("missing")).toMatchObject({
      id: placeholderId,
      call: { status: "awaiting_approval", kind: "plan" },
    });
    h.send({
      type: "interaction.closed",
      interaction: "input",
      state: "resolved",
      resolution: { kind: "plan_review", decision: "reject" },
    });
    h.end();
    expect(h.view.status).toEqual({ state: "done" });
  });
});
