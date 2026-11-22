import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  spadeChatSegments,
  spadeLiveChatSegments,
  spadeMessageId,
  spadePlainChat,
  type SpadeChatSegment,
} from "./chat-markup.ts";

// The table both parsers run (ADR 0212): Spade's Rust one reads the same file.
const table = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "..", "..", "..", "..", "spade", "docs", "chat-markup.cases.json"),
    "utf8",
  ),
) as { cases: { name: string; text: string; live?: boolean; segments: SpadeChatSegment[] }[] };

describe("a bot's words split into chat messages as the shared table says", () => {
  for (const row of table.cases)
    it(row.name, () => {
      const parse = row.live ? spadeLiveChatSegments : spadeChatSegments;
      expect(parse(row.text)).toEqual(row.segments);
    });
});

describe("streaming", () => {
  it("never draws a tag, whatever chunk the words stop at", () => {
    const text =
      '<msg>Found 3 flights.</msg>\n<msg reply="m7">Tuesday works.</msg>\n<doc title="Plan">Day 1</doc>';
    for (let end = 0; end <= text.length; end++)
      for (const segment of spadeLiveChatSegments(text.slice(0, end))) {
        expect(segment.text).not.toMatch(/<\/?(msg|doc)/);
        expect(segment.title ?? "").not.toContain('"');
      }
  });

  it("grows bubbles in order as words arrive, the last one open until it closes", () => {
    const steps = [
      "<msg>Found",
      "<msg>Found 3.</msg><msg>Cheap",
      "<msg>Found 3.</msg><msg>Cheapest.</msg>",
    ];
    expect(steps.map((text) => spadeLiveChatSegments(text))).toEqual([
      [{ kind: "msg", text: "Found", open: true }],
      [
        { kind: "msg", text: "Found 3." },
        { kind: "msg", text: "Cheap", open: true },
      ],
      [
        { kind: "msg", text: "Found 3." },
        { kind: "msg", text: "Cheapest." },
      ],
    ]);
  });
});

it("plain words drop the markup and keep every word", () => {
  expect(spadePlainChat('<msg>Hi.</msg><doc title="Plan">Day 1</doc>')).toBe(
    "Hi.\n\nPlan\n\nDay 1",
  );
});

it("a message's id comes from its event and its place in it", () => {
  expect([spadeMessageId(12), spadeMessageId(12, 1), spadeMessageId(12, 2)]).toEqual([
    "m12",
    "m12.2",
    "m12.3",
  ]);
});
