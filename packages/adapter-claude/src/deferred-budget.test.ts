import { expect, test } from "vitest";
import { harness } from "./translator.test-helper.ts";

test.each(["bytes", "frames", "parents"])(
  "a deferred child flood exceeding the %s budget holds the thread, said only in the daemon's log",
  (budget) => {
    const h = harness();
    h.init();
    const count = budget === "bytes" ? 70 : 300;
    for (let i = 0; i < count; i++)
      h.send({
        type: "assistant",
        parent_tool_use_id: budget === "parents" ? `spawn-${i}` : "spawn",
        message: {
          id: `msg-${i}`,
          content: [{ type: "text", text: budget === "bytes" ? "x".repeat(65536) : "small" }],
        },
      });
    // ace's own limit is no transcript notice and no listed task: it goes to the log.
    expect(h.items().filter((i) => i.type === "notice")).toEqual([]);
    expect(overflow(h)?.internal).toBe(true);
    expect(
      h.diagnostics.filter(
        (d) =>
          d.type === "adapter.warning" &&
          "data" in d &&
          JSON.stringify(d.data).includes("deferred-transcripts-overflow"),
      ),
    ).toHaveLength(1);
    h.system("task_started", { task_id: "C", task_type: "local_agent", tool_use_id: "spawn" });
    h.system("task_updated", { task_id: "C", patch: { status: "completed" } });
    h.result();
    expect(h.items().filter((i) => i.type === "message")).toHaveLength(0);
    expect(h.state.status.state).not.toBe("done");
    h.send({ type: "process.exited", deliberate: false }, "lifecycle", "note");
    expect(h.state.status.state).toBe("failed");
    expect(overflow(h)?.status).toBe("stopped");
  },
);

test("the transcript overflow placeholder ends once the turn ended and children went quiet", () => {
  const h = harness();
  h.init();
  for (let i = 0; i < 300; i++)
    h.send({
      type: "assistant",
      parent_tool_use_id: "spawn",
      message: { id: `msg-${i}`, content: [{ type: "text", text: "small" }] },
    });
  h.result();
  expect(overflow(h)?.status).toBe("running");
  expect(h.state.status.state).not.toBe("done");
  h.tick(h.deadline() ?? 0);
  expect(overflow(h)?.status).toBe("stopped");
  expect(h.state.status.state).toBe("done");
});

function overflow(h: ReturnType<typeof harness>) {
  return Object.entries(h.state.tasks).find(([key]) => key.endsWith(":unbound:overflow"))?.[1];
}
