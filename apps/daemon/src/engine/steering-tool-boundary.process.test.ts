import { expect, test } from "vitest";
import { transitionHarness } from "./transition-test-support.ts";

test("steering waits for foreground tools, then delivers automatically while queue mode keeps waiting", async () => {
  const h = transitionHarness();
  try {
    const id = await h.create();
    h.held.add(id);
    h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "Start work" }] });
    await h.engine.flush();
    h.emit(id, {
      type: "item.upsert",
      agent: "root",
      item: "build",
      draft: {
        type: "tool_call",
        complete: false,
        call: { title: "Build", status: "running", detail: { kind: "shell", command: "build" } },
      },
    });
    await h.engine.flush();
    const before = h.inputs.length;
    for (const delivery of ["steer", "queue"] as const)
      expect(
        h.command({
          type: "thread.send",
          threadId: id,
          input: [{ type: "text", text: delivery }],
          delivery,
        }).ok,
      ).toBe(true);
    await h.engine.flush();
    expect(h.inputs.slice(before)).toEqual([]);
    expect(h.engine.queue(id).messages).toHaveLength(2);
    h.emit(id, {
      type: "item.upsert",
      agent: "root",
      item: "build",
      draft: { type: "tool_call", complete: true, call: { status: "succeeded" } },
    });
    await h.engine.flush();
    expect(h.inputs.slice(before).map((input) => input.text)).toEqual(["steer"]);
    expect(h.engine.queue(id).messages).toHaveLength(1);
    h.emit(id, { type: "turn.ended", agent: "root", outcome: "completed" });
    await h.engine.flush();
    expect(h.inputs.slice(before).map((input) => input.text)).toEqual(["steer", "queue"]);
  } finally {
    await h.close();
  }
});
