import { DeviceId } from "@ace/protocol";
import { describe, expect, it } from "vitest";
import type { Fact } from "./index.ts";
import { harness } from "./test-helper.ts";

describe("reducer reliability", () => {
  it("late output from an older run does not change the new turn's activity", () => {
    const h = harness();
    h.see();
    h.start("root", "first");
    h.shell();
    h.background();
    h.end();
    h.start("root", "second");
    h.send({ type: "activity", agent: "root", activity: "thinking" });
    const before = structuredClone(h.state.agents.root?.agent.status);
    const events = h.send({
      type: "item.delta",
      agent: "root",
      item: "shell",
      field: "output",
      append: "late line",
    });
    expect(h.state.agents.root?.agent.status).toEqual(before);
    expect(events.map((event) => event.type)).toEqual(["item.delta"]);
  });

  it.each(["pending", "running", "awaiting_approval"] as const)(
    "turn end cancels a dangling %s tool",
    (status) => {
      const h = harness();
      h.see();
      h.start();
      h.shell();
      h.send({
        type: "item.upsert",
        agent: "root",
        item: "shell",
        draft: { type: "tool_call", call: { status } },
      });
      h.end();
      expect(h.state.items.shell).toMatchObject({
        complete: true,
        call: { status: "cancelled", error: "turn ended without completion" },
      });
    },
  );

  it.each(["turn.started", "item.upsert", "item.delta"] as const)(
    "keeps %s from an unknown agent as a provisional child",
    (type) => {
      const h = harness();
      h.see();
      const fact: Fact =
        type === "turn.started"
          ? { type, agent: "unknown", trigger: "spawn" }
          : type === "item.upsert"
            ? {
                type,
                agent: "unknown",
                item: "early",
                draft: { type: "reasoning", text: "Thinking", complete: false },
              }
            : { type, agent: "unknown", item: "early", field: "text", append: "Early text" };
      const events = h.send(fact);
      expect(events.some((event) => event.type === "agent.created")).toBe(true);
      expect(h.state.agents.unknown?.agent.parentId).toBe(h.state.agents.root?.agent.id);
      expect(h.state.agents.unknown?.agent.fidelity).toBe("placeholder");
      h.see("unknown", "root");
      expect(h.state.agents.unknown?.agent.fidelity).toBe("full");
      expect(h.state.status.state).toBe("working");
    },
  );

  it("creates an unknown parent before its known child without losing either", () => {
    const h = harness();
    h.see();
    h.see("grandchild", "missing-parent");
    expect(h.state.agents["missing-parent"]?.agent.parentId).toBe(h.state.agents.root?.agent.id);
    expect(h.state.agents.grandchild?.agent.parentId).toBe(
      h.state.agents["missing-parent"]?.agent.id,
    );
    h.see("missing-parent", "root");
    expect(h.state.agents["missing-parent"]?.agent.fidelity).toBe("full");
  });

  it("applies nested partial tool refreshes without dropping previous input, output, or identity", () => {
    const h = harness("cursor");
    h.see();
    h.start();
    h.shell();
    const item = structuredClone(h.state.items.shell);
    h.send({
      type: "item.delta",
      agent: "root",
      item: "shell",
      field: "output",
      append: "first\n",
    });
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "shell",
      draft: {
        type: "tool_call",
        call: { title: "Actual command", detail: { kind: "shell", exitCode: 0 } },
      },
    });
    expect(h.state.items.shell).toMatchObject({
      id: item?.id,
      runId: item?.runId,
      call: {
        title: "Actual command",
        status: "running",
        detail: { command: "loop", output: "first\n", exitCode: 0 },
      },
    });
  });

  it("keeps message parts while appending text and keeps reasoning and tool output separately", () => {
    const h = harness();
    h.see();
    h.start();
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "message",
      draft: {
        type: "message",
        role: "assistant",
        parts: [
          { type: "text", text: "Hello" },
          { type: "image", mimeType: "image/png", url: "data:image/png;base64,AA==" },
        ],
        complete: false,
      },
    });
    h.send({ type: "item.delta", agent: "root", item: "message", field: "text", append: " world" });
    expect(h.state.items.message).toMatchObject({
      type: "message",
      parts: [
        { type: "text", text: "Hello" },
        { type: "image", mimeType: "image/png" },
        { type: "text", text: " world" },
      ],
    });
    h.send({
      type: "item.delta",
      agent: "root",
      item: "reasoning",
      field: "reasoning",
      append: "Why",
    });
    h.send({
      type: "item.delta",
      agent: "root",
      item: "output",
      field: "output",
      append: "Output",
    });
    expect(h.state.items.reasoning).toMatchObject({ type: "reasoning", text: "Why" });
    expect(h.state.items.output).toMatchObject({
      type: "tool_call",
      call: { detail: { output: "Output" } },
    });
  });

  it("keeps a late completed item on its original run while a newer turn runs", () => {
    const h = harness();
    h.see();
    h.start("root", "first");
    h.shell();
    h.background();
    h.end();
    const originalRun = h.state.items.shell?.runId;
    const started = h.start("root", "second").find((event) => event.type === "run.started");
    expect(started?.run.nativeId).toBe("second");
    const events = h.send({
      type: "item.upsert",
      agent: "root",
      item: "shell",
      draft: { type: "tool_call", complete: true, call: { status: "succeeded" } },
    });
    expect(h.state.items.shell?.runId).toBe(originalRun);
    expect(events.filter((event) => event.type === "run.ended")).toHaveLength(0);
    expect(started && h.state.runs[started.run.id]).toMatchObject({ state: "active" });
  });

  it("ignores a duplicate native turn start and end, including late stale ends", () => {
    const h = harness("opencode");
    h.see();
    h.start("root", "first");
    expect(h.start("root", "first").filter((event) => event.type === "run.started")).toHaveLength(
      0,
    );
    h.send({ type: "turn.ended", agent: "root", nativeTurnId: "first", outcome: "interrupted" });
    expect(
      h
        .send({ type: "turn.ended", agent: "root", nativeTurnId: "first", outcome: "interrupted" })
        .filter((event) => event.type === "run.ended"),
    ).toHaveLength(0);
    const started = h.start("root", "second").find((event) => event.type === "run.started");
    h.shell();
    const events = h.send({
      type: "turn.ended",
      agent: "root",
      nativeTurnId: "first",
      outcome: "interrupted",
    });
    expect(events.filter((event) => event.type === "run.ended")).toHaveLength(0);
    expect(started && h.state.runs[started.run.id]).toMatchObject({
      nativeId: "second",
      state: "active",
    });
    expect(h.state.items.shell).toMatchObject({ call: { status: "running" } });
    expect(h.state.status.state).toBe("working");
  });

  it("OpenCode accepts an actual cancelled tool completion after idle and collapses its second idle", () => {
    const h = harness("opencode");
    h.see();
    h.start();
    h.shell();
    h.end("root", "interrupted");
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "shell",
      draft: {
        type: "tool_call",
        complete: true,
        call: {
          status: "cancelled",
          detail: { kind: "shell", exitCode: null, output: "User aborted the command" },
        },
      },
    });
    const events = h.end("root", "interrupted");
    expect(events.filter((event) => event.type === "run.ended")).toHaveLength(0);
    expect(h.state.items.shell).toMatchObject({
      call: { status: "cancelled", detail: { output: "User aborted the command" } },
    });
    expect(h.state.status).toEqual({ state: "done" });
  });

  it("turn ending cancels only its own blocking questions and dangling tools", () => {
    const h = harness();
    h.see();
    h.start();
    h.shell("dangling");
    h.shell("surviving");
    h.background("job", "surviving");
    h.question("blocking");
    h.question("async", "root", false);
    h.see("child", "root");
    h.start("child");
    h.question("child-question", "child");
    h.end();
    expect(h.state.items.dangling).toMatchObject({ call: { status: "cancelled" } });
    expect(h.state.items.surviving).toMatchObject({ call: { status: "running" } });
    expect(h.state.interactions.blocking?.state).toBe("cancelled");
    expect(h.state.interactions.async?.state).toBe("pending");
    expect(h.state.interactions["child-question"]?.state).toBe("pending");
  });

  it("parallel Cursor tools finish out of order without cancelling their siblings", () => {
    const h = harness("cursor");
    h.see();
    h.start();
    h.shell("first");
    h.shell("second");
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "second",
      draft: { type: "tool_call", complete: true, call: { status: "succeeded" } },
    });
    expect(h.state.agents.root?.agent.status).toMatchObject({
      state: "working",
      activity: "tool",
      itemId: h.state.items.first?.id,
    });
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "first",
      draft: { type: "tool_call", complete: true, call: { status: "succeeded" } },
    });
    h.end();
    expect(h.state.status).toEqual({ state: "done" });
  });

  it("parallel approvals resolve independently and the first device answer wins", () => {
    const h = harness();
    h.see();
    h.start();
    h.question("one");
    h.question("two");
    const answer: Fact = {
      type: "interaction.closed",
      interaction: "one",
      state: "resolved",
      resolvedBy: DeviceId.parse("phone"),
      resolution: { kind: "question", answers: { q: ["yes"] } },
    };
    h.send(answer);
    expect(h.state.status).toEqual({ state: "needs_you", interactions: 1 });
    const later = h.send({
      ...answer,
      resolvedBy: DeviceId.parse("desktop"),
      resolution: { kind: "question", answers: { q: ["no"] } },
    });
    expect(later.filter((event) => event.type === "interaction.closed")).toHaveLength(0);
    expect(h.state.interactions.one).toMatchObject({
      resolvedBy: "phone",
      resolution: { answers: { q: ["yes"] } },
    });
    h.send({ type: "interaction.closed", interaction: "two", state: "cancelled" });
    expect(h.state.status.state).toBe("working");
  });

  it("question dismissal and plan rejection are resolved answers and do not imply failed runs", () => {
    const h = harness("opencode");
    h.see();
    h.start();
    h.question();
    h.send({
      type: "interaction.closed",
      interaction: "question",
      state: "resolved",
      resolution: { kind: "question", answers: {}, dismissed: true },
    });
    h.send({
      type: "interaction.opened",
      agent: "root",
      interaction: "plan",
      blocking: true,
      request: { kind: "plan_review", markdown: "", planPath: "/repo/plan.md" },
    });
    h.send({
      type: "interaction.closed",
      interaction: "plan",
      state: "resolved",
      resolution: { kind: "plan_review", decision: "reject" },
    });
    h.end();
    expect(h.state.status).toEqual({ state: "done" });
    expect(Object.values(h.state.runs)[0]?.state).toBe("completed");
  });
});
