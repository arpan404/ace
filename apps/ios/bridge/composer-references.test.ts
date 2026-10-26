import { expect, test } from "vitest";
import { References, messageContent, placeReferences } from "./composer-references.ts";

const file = (path: string) => ({
  label: `@${path.slice(path.lastIndexOf("/") + 1)}`,
  file: { path },
});

test("a file reference is found only where its words stand alone, never inside a longer name", () => {
  const placed = placeReferences("open @main.tsx then @main.ts", [file("src/main.ts")]);
  expect(placed).toEqual([
    { start: 20, end: 28, label: "@main.ts", file: { path: "src/main.ts" } },
  ]);
});

test("two picks of the same words claim one place each, in the message's order", () => {
  const placed = placeReferences("@a.ts and @a.ts", [file("x/a.ts"), file("y/a.ts")]);
  expect(placed.map((token) => [token.start, token.file?.path])).toEqual([
    [0, "x/a.ts"],
    [10, "y/a.ts"],
  ]);
});

test("words with no references stay one plain message", () => {
  expect(messageContent("just words", [], undefined)).toEqual({
    input: [{ type: "text", text: "just words" }],
    references: undefined,
  });
});

test("a malformed reference from the phone is dropped, the rest still go", () => {
  const parsed = References.parse([
    { label: "@a.ts", file: { path: "a.ts" } },
    { nope: true },
    { label: "Tab", browserTab: { type: "browser_tab" } },
  ]);
  expect(parsed).toEqual([{ label: "@a.ts", file: { path: "a.ts" } }, { label: "Tab" }]);
  expect(messageContent("see @a.ts and Tab", parsed, undefined).references).toEqual({
    mentions: [{ path: "a.ts" }],
  });
});
