import { expect, test } from "vitest";
import { References, messageContent, placeReferences } from "./composer-references.ts";

const file = (path: string, start: number) => {
  const label = `@${path.slice(path.lastIndexOf("/") + 1)}`;
  return { label, start, end: start + label.length, file: { path } };
};
const review = (start: number) => ({
  label: "Review",
  start,
  end: start + 6,
  catalog: {
    type: "mention" as const,
    entryId: "claude:skill:review",
    name: "review",
    kind: "skill" as const,
    arguments: "",
  },
});

test("a skill whose pick was deleted stays deleted when the same word is typed again", () => {
  // "Review " was picked at 0, deleted, and "Review the diff" typed by hand.
  const content = messageContent("Please Review the diff", [review(0)], undefined);
  expect(content.input).toEqual([{ type: "text", text: "Please Review the diff" }]);
});

test("a file goes from the folder it was picked in, not another file with the same name", () => {
  // @a.ts from x/ was deleted; @a.ts from y/ was picked in its place.
  const text = "see @a.ts now";
  const placed = placeReferences(text, [file("x/a.ts", 0), file("y/a.ts", 4)]);
  expect(placed.map((token) => token.file?.path)).toEqual(["y/a.ts"]);
  expect(messageContent(text, [file("y/a.ts", 4)], undefined).references).toEqual({
    mentions: [{ path: "y/a.ts" }],
  });
});

test("a pick still where it was goes inline, at its place in the words", () => {
  expect(messageContent("Review this", [review(0)], undefined).input).toEqual([
    review(0).catalog,
    { type: "text", text: " this" },
  ]);
});

test("words with no references stay one plain message", () => {
  expect(messageContent("just words", [], undefined)).toEqual({
    input: [{ type: "text", text: "just words" }],
    references: undefined,
  });
});

test("a malformed reference is dropped and picks past the limit are left out, never failing", () => {
  const many = Array.from({ length: 70 }, (_, index) => file(`f${index}.ts`, 0));
  const parsed = References.parse([{ nope: true }, ...many]);
  expect(parsed).toHaveLength(64);
  expect(parsed[0]?.file?.path).toBe("f0.ts");
});

test("lines picked in the file viewer go as a mention of just those lines", () => {
  const label = "@src/relay/outbox.ts:12-20";
  const text = `Why does ${label} retry twice?`;
  // As Swift sends it: the line numbers arrive as JSON numbers.
  const [reference] = References.parse([
    {
      label,
      start: 9,
      end: 9 + label.length,
      file: { path: "src/relay/outbox.ts", lines: { start: 12, end: 20 } },
    },
  ]);
  const content = messageContent(text, reference ? [reference] : [], undefined);
  expect(content.references?.mentions).toEqual([
    { path: "src/relay/outbox.ts", lines: { start: 12, end: 20 } },
  ]);
});
