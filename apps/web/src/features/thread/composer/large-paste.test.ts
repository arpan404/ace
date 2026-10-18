import { expect, test } from "vitest";
import { pastedFile } from "./large-paste.ts";

test("a short paste stays inline", () => {
  expect(pastedFile("npm run build")).toBeUndefined();
  expect(pastedFile(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"))).toBeUndefined();
});

test("more than forty lines becomes a text file named for its line count", () => {
  const log = Array.from({ length: 41 }, (_, i) => `line ${i}`).join("\n");
  expect(pastedFile(`${log}\n`)).toEqual({ name: "Pasted 41 lines.txt", lines: 41 });
});

test("one very long line becomes a file too", () => {
  expect(pastedFile("x".repeat(2049))).toEqual({ name: "Pasted 1 line.txt", lines: 1 });
});
