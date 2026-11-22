import { expect, test } from "vitest";
import { committedFromPatch, exactPatchHunks } from "./exact-patch.ts";

const section = (...lines: string[]) =>
  ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", ...lines, ""].join("\n");

test.each([
  {
    name: "a committed last line with no newline keeps none",
    disk: "one\nTWO\n",
    patch: section("@@ -1,2 +1,2 @@", " one", "-two", "\\ No newline at end of file", "+TWO"),
    committed: "one\ntwo",
  },
  {
    name: "a disk last line with no newline over a committed one with a newline",
    disk: "one\nTWO",
    patch: section("@@ -1,2 +1,2 @@", " one", "-two", "+TWO", "\\ No newline at end of file"),
    committed: "one\ntwo\n",
  },
  {
    name: "CRLF lines keep their CR",
    disk: "one\r\nTWO\r\nthree\r\n",
    patch: section("@@ -1,3 +1,3 @@", " one\r", "-two\r", "+TWO\r", " three\r"),
    committed: "one\r\ntwo\r\nthree\r\n",
  },
  {
    name: "a mixed file keeps each line's own ending",
    disk: "one\r\nTWO\nthree\r\n",
    patch: section("@@ -1,3 +1,3 @@", " one\r", "-two", "+TWO", " three\r"),
    committed: "one\r\ntwo\nthree\r\n",
  },
  {
    name: "lines added at the top come out",
    disk: "new\none\n",
    patch: section("@@ -0,0 +1 @@", "+new"),
    committed: "one\n",
  },
  {
    name: "a new file was nothing",
    disk: "a\nb\n",
    patch: section("@@ -0,0 +1,2 @@", "+a", "+b"),
    committed: "",
  },
])("$name", ({ disk, patch, committed }) => {
  expect(committedFromPatch(disk, patch)).toBe(committed);
});

test("a patch read for another version of the file gives no committed text", () => {
  const patch = section("@@ -1,2 +1,2 @@", " one", "-two", "+TWO");
  expect(committedFromPatch("one\nTwo, typed\n", patch)).toBeUndefined();
});

test("a patch's hunks carry the exact committed text of each change", () => {
  const patch = section("@@ -1,3 +1,3 @@", " one\r", "-two\r", "+TWO\r", " three\r");
  expect(exactPatchHunks(patch)).toEqual([
    {
      start: 2,
      marks: [2],
      added: ["TWO"],
      removed: ["two"],
      removedText: "two\r\n",
      above: "one",
      below: "three",
    },
  ]);
});
