import { Item } from "@ace/protocol";
import { expect, it } from "vitest";
import { applyDelta } from "./index.ts";

it.each(["reasoning", "notice"] as const)(
  "accepts text and reasoning appends on a %s item",
  (type) => {
    const item = Item.parse({
      id: "i",
      agentId: "a",
      type,
      text: "Start",
      level: "info",
      createdAt: 1,
      complete: false,
    });
    expect(applyDelta(item, "text", " text")).toBe(true);
    expect(applyDelta(item, "reasoning", " thought")).toBe(true);
    expect(item).toMatchObject({ text: "Start text thought" });
    const before = structuredClone(item);
    expect(applyDelta(item, "output", "ignored")).toBe(false);
    expect(item).toEqual(before);
  },
);
it("counts UTF-8 bytes and keeps a whole-character output tail across chunk boundaries", () => {
  const item = Item.parse({
    id: "i",
    agentId: "a",
    type: "tool_call",
    createdAt: 1,
    complete: false,
    call: {
      id: "i",
      agentId: "a",
      kind: "shell",
      title: "Shell",
      status: "running",
      startedAt: 1,
      raw: [],
      detail: { kind: "shell", command: "echo" },
    },
  });
  applyDelta(item, "output", "x".repeat(4094) + "😀");
  expect(item).toMatchObject({
    call: {
      detail: {
        output: {
          streamId: "output:i",
          bytes: 4098,
          tail: "x".repeat(4092) + "😀",
          truncated: true,
        },
      },
    },
  });
  applyDelta(item, "output", "é");
  expect(item).toMatchObject({
    call: { detail: { output: { bytes: 4100, tail: "x".repeat(4090) + "😀é" } } },
  });
  // A large append whose leading character straddles the tail cutoff must
  // not fill the spare bytes with characters from the previous chunk.
  applyDelta(item, "output", "😀" + "y".repeat(4093));
  expect(item).toMatchObject({
    call: { detail: { output: { bytes: 8197, tail: "y".repeat(4093) } } },
  });
});
