import { expect, test } from "vitest";
import { setup } from "./translator.test-helper.ts";
import { createCodexTranslator } from "./index.ts";
import { ThreadId } from "@ace/protocol";
function bytes(count: number) {
  const translator = createCodexTranslator({
    threadId: ThreadId.parse("stream"),
    rootKey: "root",
  });
  let total = 0;
  for (let i = 0; i < count; i++)
    for (const fact of translator.translate(
      {
        seq: i,
        t: i,
        dir: "recv",
        channel: "stdio",
        data: {
          method: i === 0 ? "thread/started" : "item/plan/delta",
          params:
            i === 0
              ? { thread: { id: "native" } }
              : { threadId: "native", itemId: "p", delta: "x".repeat(100) },
        },
      },
      i,
    ))
      total += JSON.stringify(fact).length;
  return total;
}
test("plan chunks append once and emitted traffic grows in proportion to incoming bytes", () => {
  expect(bytes(2000)).toBeLessThan(bytes(1000) * 2.1);
  const h = setup();
  h.start();
  h.item({ id: "p", type: "plan", text: "" });
  for (const delta of ["# Plan", "\nFinish"])
    h.recv("item/plan/delta", { threadId: "native", itemId: "p", delta });
  expect(
    Object.values(h.state.items).some((i) => i.type === "notice" && i.text === "# Plan\nFinish"),
  ).toBe(true);
  h.item({ id: "p", type: "plan", text: "# Plan\nFinish" }, true);
  expect(
    Object.values(h.state.items).some(
      (i) =>
        i.type === "tool_call" &&
        i.call.detail.kind === "plan" &&
        i.call.detail.markdown === "# Plan\nFinish",
    ),
  ).toBe(true);
});
test("overflowed unknown streams retain raw frames and hold completion until authoritative hydration", () => {
  const h = setup();
  h.start();
  h.start("child", "child-turn");
  for (let i = 0; i < 70; i++)
    h.recv("item/agentMessage/delta", { threadId: "child", itemId: "m", delta: `chunk-${i}` });
  h.end("completed", "child", "child-turn");
  h.item({ id: "spawn", type: "subAgentActivity", kind: "started", agentThreadId: "child" }, true);
  h.end();
  expect(h.state.status.state).not.toBe("done");
  expect(
    Object.values(h.state.items).some(
      (i) =>
        i.type === "notice" &&
        i.raw.some((r) => "data" in r && JSON.stringify(r.data).includes("chunk-0")),
    ),
  ).toBe(true);
  h.feed({
    seq: 999,
    t: 1000,
    dir: "note",
    channel: "stdio",
    data: {
      event: "thread-discovered",
      thread: {
        id: "child",
        parentThreadId: "native",
        status: { type: "idle" },
        turns: [
          {
            id: "child-turn",
            status: "completed",
            items: [{ id: "m", type: "agentMessage", text: "recovered" }],
          },
        ],
      },
    },
  });
  h.item(
    { id: "spawn-again", type: "subAgentActivity", kind: "started", agentThreadId: "child" },
    true,
  );
  expect(h.state.status.state).toBe("done");
});
