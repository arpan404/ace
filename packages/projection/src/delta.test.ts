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

it("messages ignore reasoning and output fields without losing or creating text parts", () => {
  const item = Item.parse({
    id: "m",
    agentId: "a",
    type: "message",
    role: "assistant",
    parts: [],
    createdAt: 1,
    complete: false,
  });
  expect(applyDelta(item, "reasoning", "hidden")).toBe(false);
  expect(applyDelta(item, "output", "hidden")).toBe(false);
  expect(item).toMatchObject({ parts: [] });
  expect(applyDelta(item, "text", "visible")).toBe(true);
  expect(applyDelta(item, "reasoning", "hidden")).toBe(false);
  expect(item).toMatchObject({ parts: [{ type: "text", text: "visible" }] });
});

const preview = (text: string, source: Record<string, unknown>) =>
  Item.parse({
    id: "m",
    agentId: "a",
    type: "message",
    role: "assistant",
    createdAt: 1,
    complete: false,
    parts: [
      { type: "text", text, source: { streamId: "text:m", encoding: "utf-16le", ...source } },
    ],
  });
const lastText = (item: Item) => {
  const part = item.type === "message" ? item.parts.at(-1) : undefined;
  return part?.type === "text" ? part : undefined;
};

it("a preview marked as the stream's tail keeps extending with each delta", () => {
  // 100 units carried of a 1,000-unit stream: units 900 to 1,000.
  const item = preview("t".repeat(100), { bytes: 2000, offset: 1800 });
  applyDelta(item, "text", " next");
  expect(lastText(item)).toMatchObject({
    text: "t".repeat(100) + " next",
    source: { bytes: 2010, offset: 1800 },
  });
});

it("a preview of the stream's head stays as sent while its source counts on", () => {
  for (const source of [
    { bytes: 2000 },
    { bytes: 2000, offset: 0 },
    { bytes: 2000, offset: 600 },
  ]) {
    const item = preview("h".repeat(100), source);
    applyDelta(item, "text", " next");
    expect(lastText(item)).toMatchObject({ text: "h".repeat(100), source: { bytes: 2010 } });
  }
});

it("a preview whose offset disagrees with its length is left as sent, never extended wrongly", () => {
  for (const offset of [1900, 4000]) {
    const item = preview("h".repeat(100), { bytes: 2000, offset });
    applyDelta(item, "text", " next");
    expect(lastText(item)).toMatchObject({ text: "h".repeat(100), source: { bytes: 2010 } });
  }
});
