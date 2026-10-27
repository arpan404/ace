import { expect, test } from "vitest";
import { gitPatchFiles } from "./git-patch.ts";
import { PatchFileReader } from "./git-patch-reader.ts";

const section = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " one",
  "-two",
  "+two changed",
  " three",
  "@@ -40,2 +40,3 @@ tail()",
  " forty",
  "+forty-one",
  " forty-two",
].join("\n");

test("a section read in parts cut mid-line makes the rows of reading it whole", () => {
  const whole = gitPatchFiles(`${section}\n`)[0]?.rows;
  for (const size of [1, 2, 5, 13, 64]) {
    const reader = new PatchFileReader();
    for (let at = 0; at < section.length; at += size) reader.push(section.slice(at, at + size));
    reader.end();
    expect(reader.rows).toEqual(whole);
  }
});

test("a section cut short ends with its last partial line, and the next file's section is not read", () => {
  const next =
    "diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-x\n+y\n";
  const reader = new PatchFileReader();
  reader.push(`${section}\n${next}`);
  reader.end();
  expect(reader.rows).toEqual(gitPatchFiles(`${section}\n`)[0]?.rows);
  const cut = new PatchFileReader();
  cut.push(section.slice(0, section.indexOf("two changed") + 3));
  cut.end();
  expect(cut.rows.at(-1)).toEqual({ kind: "add", new: 2, text: "two" });
});
