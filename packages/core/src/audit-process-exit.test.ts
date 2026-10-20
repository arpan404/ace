import { expect, it } from "vitest";
import { nextDeadline } from "./index.ts";
import { harness } from "./test-helper.ts";

it.each([false, true])(
  "dead tools from an ended turn cannot hide silence after a deliberate=%s restart",
  (deliberate) => {
    const h = harness("codex", { silenceMs: 10 });
    h.start();
    h.background("old-task", "old-shell");
    h.end();
    const exited = h.send({ type: "process.exited", deliberate }, 200);
    expect(exited).toContainEqual(
      expect.objectContaining({
        type: "item.updated",
        item: expect.objectContaining({
          complete: true,
          call: expect.objectContaining({ status: "cancelled", endedAt: 200 }),
        }),
      }),
    );
    expect(h.item("old-shell")).toMatchObject({ call: { status: "cancelled", endedAt: 200 } });
    expect(h.task("old-task")?.status).toBe("unknown");
    expect(h.send({ type: "process.exited", deliberate }, 250)).toEqual([]);
    expect(h.item("old-shell")).toMatchObject({ call: { endedAt: 200 } });
    h.send({ type: "process.started" }, 251);
    h.start("root", "replacement");
    expect(nextDeadline(h.state)).toBe(263);
    expect(h.send({ type: "tick" }, 1000)).toContainEqual({
      type: "thread.updated",
      status: { state: "unresponsive" },
    });
    expect(h.agent("root")?.status).toEqual({ state: "unresponsive", lastSignalAt: 252 });
  },
);

it("a provider process that dies mid-thought leaves no thought still going", () => {
  const h = harness("opencode");
  h.start();
  h.send({ type: "item.delta", agent: "root", item: "thought", field: "reasoning", append: "Hm" });
  h.send({ type: "process.exited", deliberate: false }, 300);
  expect(h.item("thought")).toMatchObject({ type: "reasoning", text: "Hm", complete: true });
});

it("one agent's turn ending keeps another agent's reply streaming", () => {
  const h = harness("claude");
  h.start();
  h.see("child", "root");
  h.start("child");
  h.send({ type: "item.delta", agent: "child", item: "reply", field: "text", append: "Wo" });
  h.send({ type: "item.delta", agent: "root", item: "thought", field: "reasoning", append: "A" });
  h.end("root", "interrupted");
  expect(h.item("thought")?.complete).toBe(true);
  expect(h.item("reply")?.complete).toBe(false);
  h.end("child");
  expect(h.item("reply")?.complete).toBe(true);
});
