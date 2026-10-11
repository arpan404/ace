import { expect, test } from "vitest";
import { harness } from "./translator.test-helper.ts";

test.each(["bytes", "frames", "parents"])(
  "a deferred child flood exceeding the %s budget stays visibly unresolved",
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
    expect(
      h.items().filter((i) => i.type === "notice" && /transcript.*limit/i.test(i.text)),
    ).toHaveLength(1);
    h.system("task_started", { task_id: "C", task_type: "local_agent", tool_use_id: "spawn" });
    h.system("task_updated", { task_id: "C", patch: { status: "completed" } });
    h.result();
    expect(h.items().filter((i) => i.type === "message")).toHaveLength(0);
    expect(h.state.status.state).not.toBe("done");
    h.send({ type: "process.exited", deliberate: false }, "lifecycle", "note");
    expect(h.state.status.state).toBe("failed");
  },
);
