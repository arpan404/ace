import { expect, test } from "vitest";
import { bubbleContent, referenceSegments } from "./bubble-content.ts";
import { bubbleSegments, isLongMessage } from "./bubble-segments.ts";

const mention = (name: string, title?: string) => ({
  type: "mention" as const,
  entryId: name,
  name,
  ...(title ? { title } : {}),
  kind: "skill" as const,
  arguments: "",
});

test("mentions sit among the person's words where they were written", () => {
  const segments = referenceSegments([
    { type: "text", text: "Use " },
    mention("review", "Code review"),
    { type: "text", text: " on this branch" },
  ]);
  expect(segments).toEqual([
    { kind: "text", text: "Use " },
    { kind: "mention", name: "Code review", mention: "skill" },
    { kind: "text", text: " on this branch" },
  ]);
});

test("a message of only a mention still has something to read", () => {
  expect(bubbleContent([mention("review")]).readable).toBe(true);
  expect(bubbleContent([{ type: "text", text: "  " }]).readable).toBe(false);
});

test("fenced code in the bubble is its own run between the prose", () => {
  expect(bubbleSegments("Run this:\n```sh\nbun test\n```\nthen tell me")).toEqual([
    { kind: "text", text: "Run this:" },
    { kind: "code", text: "bun test" },
    { kind: "text", text: "then tell me" },
  ]);
});

test("a long message folds past twelve lines", () => {
  expect(isLongMessage(Array.from({ length: 13 }, (_, i) => `line ${i}`).join("\n"))).toBe(true);
  expect(isLongMessage("one line")).toBe(false);
});
