import { describe, expect, it } from "vitest";
import { harness } from "./test-helper.ts";

// Every `h.send` also folds the emitted events into a client view and checks it against the
// reducer's own state (`test-helper.ts`), so a skipped event that mattered fails there too.
describe("appends that change nothing", () => {
  it("an empty reasoning append (a thinking signature) sends no delta", () => {
    const h = harness("claude");
    h.see();
    h.start();
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "reason",
      draft: { type: "reasoning", text: "", complete: false },
    });
    h.send({ type: "item.delta", agent: "root", item: "reason", field: "reasoning", append: "a" });
    const events = h.send({
      type: "item.delta",
      agent: "root",
      item: "reason",
      field: "reasoning",
      append: "",
    });
    expect(events.filter((event) => event.type === "item.delta")).toEqual([]);
    expect(h.item("reason")).toMatchObject({ text: "a" });
  });

  it("an empty append that only refreshes liveness still brings the agent back", () => {
    const h = harness("claude", { silenceMs: 100 });
    h.see();
    h.start();
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "reason",
      draft: { type: "reasoning", text: "", complete: false },
    });
    h.send({ type: "tick" }, 1000);
    expect(h.agent("root")?.status).toMatchObject({ state: "unresponsive" });
    const events = h.send(
      { type: "item.delta", agent: "root", item: "reason", field: "reasoning", append: "" },
      1001,
    );
    expect(events.some((event) => event.type === "item.delta")).toBe(false);
    expect(h.agent("root")?.status).toMatchObject({ state: "working" });
  });

  it("an empty append that opens a message's first text part is still sent", () => {
    const h = harness("claude");
    h.see();
    h.start();
    const events = h.send({
      type: "item.delta",
      agent: "root",
      item: "reply",
      field: "text",
      append: "",
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "item.delta", append: "" }));
    expect(h.item("reply")).toMatchObject({ parts: [{ type: "text", text: "" }] });
  });

  it("an empty first output read still gives a shell call its output summary", () => {
    const h = harness("opencode");
    h.see();
    h.start();
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "shell",
      draft: {
        type: "tool_call",
        call: {
          kind: "shell",
          title: "ls",
          status: "running",
          detail: { kind: "shell", command: "ls" },
        },
      },
    });
    const first = h.send({
      type: "item.delta",
      agent: "root",
      item: "shell",
      field: "output",
      append: "",
    });
    expect(first.some((event) => event.type === "item.delta")).toBe(true);
    const again = h.send({
      type: "item.delta",
      agent: "root",
      item: "shell",
      field: "output",
      append: "",
    });
    expect(again.some((event) => event.type === "item.delta")).toBe(false);
    expect(h.item("shell")).toMatchObject({
      call: { detail: { output: { bytes: 0, tail: "" } } },
    });
  });
});
