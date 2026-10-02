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
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "shell",
      draft: { type: "tool_call", complete: true, call: { status: "succeeded" } },
    });
    h.start("root", "second");
    h.send({ type: "activity", agent: "root", activity: "thinking" });
    const before = structuredClone(h.agent("root")?.status);
    const events = h.send({
      type: "item.delta",
      agent: "root",
      item: "shell",
      field: "output",
      append: "late line",
    });
    expect(h.agent("root")?.status).toEqual(before);
    expect(events.map((event) => event.type)).toEqual(["item.delta"]);
  });

  it("a late older-run upsert preserves the current turn's activity", () => {
    const h = harness();
    h.see();
    h.start("root", "first");
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "older-response",
      draft: {
        type: "message",
        role: "assistant",
        parts: [{ type: "text", text: "Earlier response" }],
        complete: false,
      },
    });
    const olderRun = h.item("older-response")?.runId;
    h.end();
    h.start("root", "second");
    h.send({ type: "activity", agent: "root", activity: "thinking" });
    const events = h.send({
      type: "item.upsert",
      agent: "root",
      item: "older-response",
      draft: {
        type: "message",
        parts: [{ type: "text", text: "Delayed earlier response" }],
        complete: false,
      },
    });
    expect(h.item("older-response")).toMatchObject({
      runId: olderRun,
      parts: [{ type: "text", text: "Delayed earlier response" }],
    });
    expect(h.agent("root")?.status).toEqual({ state: "working", activity: "thinking" });
    expect(events.map((event) => event.type)).toEqual(["item.updated"]);
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
      expect(h.item("shell")).toMatchObject({
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
      expect(h.agent("unknown")?.parentId).toBe(h.agent("root")?.id);
      expect(h.agent("unknown")?.fidelity).toBe("placeholder");
      h.see("unknown", "root");
      expect(h.agent("unknown")?.fidelity).toBe("full");
      expect(h.view.status.state).toBe("working");
    },
  );

  it("creates an unknown parent before its known child without losing either", () => {
    const h = harness();
    h.see();
    h.see("grandchild", "missing-parent");
    expect(h.agent("missing-parent")?.parentId).toBe(h.agent("root")?.id);
    expect(h.agent("grandchild")?.parentId).toBe(h.agent("missing-parent")?.id);
    h.see("missing-parent", "root");
    expect(h.agent("missing-parent")?.fidelity).toBe("full");
  });

  it("applies nested partial tool refreshes without dropping previous input, output, or identity", () => {
    const h = harness("cursor");
    h.see();
    h.start();
    h.shell();
    const item = structuredClone(h.item("shell"));
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
    expect(h.item("shell")).toMatchObject({
      id: item?.id,
      runId: item?.runId,
      call: {
        title: "Actual command",
        status: "running",
        detail: {
          command: "loop",
          output: { bytes: 6, tail: "first\n", truncated: false },
          exitCode: 0,
        },
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
    expect(h.item("message")).toMatchObject({
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
    expect(h.item("reasoning")).toMatchObject({ type: "reasoning", text: "Why" });
    expect(h.item("output")).toMatchObject({
      type: "tool_call",
      call: { detail: { output: { bytes: 6, tail: "Output", truncated: false } } },
    });
  });

  it("keeps a late completed item on its original run while a newer turn runs", () => {
    const h = harness();
    h.see();
    h.start("root", "first");
    h.shell();
    h.background();
    h.end();
    const originalRun = h.item("shell")?.runId;
    const started = h.start("root", "second").find((event) => event.type === "run.started");
    expect(started?.run.nativeId).toBe("second");
    const events = h.send({
      type: "item.upsert",
      agent: "root",
      item: "shell",
      draft: { type: "tool_call", complete: true, call: { status: "succeeded" } },
    });
    expect(h.item("shell")?.runId).toBe(originalRun);
    expect(events.filter((event) => event.type === "run.ended")).toHaveLength(0);
    expect(started && h.view.runs[started.run.id]).toMatchObject({ state: "active" });
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
    expect(started && h.view.runs[started.run.id]).toMatchObject({
      nativeId: "second",
      state: "active",
    });
    expect(h.item("shell")).toMatchObject({ call: { status: "running" } });
    expect(h.view.status.state).toBe("working");
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
          detail: { kind: "shell", exitCode: null },
        },
      },
    });
    h.send({
      type: "item.delta",
      agent: "root",
      item: "shell",
      field: "output",
      append: "User aborted the command",
    });
    const events = h.end("root", "interrupted");
    expect(events.filter((event) => event.type === "run.ended")).toHaveLength(0);
    expect(h.item("shell")).toMatchObject({
      call: { status: "cancelled", detail: { output: { tail: "User aborted the command" } } },
    });
    expect(h.view.status).toEqual({ state: "done" });
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
    expect(h.item("dangling")).toMatchObject({ call: { status: "cancelled" } });
    expect(h.item("surviving")).toMatchObject({ call: { status: "running" } });
    expect(h.interaction("blocking")?.state).toBe("cancelled");
    expect(h.interaction("async")?.state).toBe("pending");
    expect(h.interaction("child-question")?.state).toBe("pending");
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
    expect(h.agent("root")?.status).toMatchObject({
      state: "working",
      activity: "tool",
      itemId: h.item("first")?.id,
    });
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "first",
      draft: { type: "tool_call", complete: true, call: { status: "succeeded" } },
    });
    h.end();
    expect(h.view.status).toEqual({ state: "done" });
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
    expect(h.view.status).toEqual({ state: "needs_you", interactions: 1 });
    const later = h.send({
      ...answer,
      resolvedBy: DeviceId.parse("desktop"),
      resolution: { kind: "question", answers: { q: ["no"] } },
    });
    expect(later.filter((event) => event.type === "interaction.closed")).toHaveLength(0);
    expect(h.interaction("one")).toMatchObject({
      resolvedBy: "phone",
      resolution: { answers: { q: ["yes"] } },
    });
    h.send({ type: "interaction.closed", interaction: "two", state: "cancelled" });
    expect(h.view.status.state).toBe("working");
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
    expect(h.view.status).toEqual({ state: "done" });
    expect(Object.values(h.view.runs)[0]?.state).toBe("completed");
  });
});
