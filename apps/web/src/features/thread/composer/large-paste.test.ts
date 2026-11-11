import { expect, test } from "vitest";
import { editedName, isPasted, pastedFile } from "./large-paste.ts";

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

test("an edited paste is renamed for its new line count", () => {
  expect(editedName("Pasted 41 lines.txt", "one\ntwo\n")).toBe("Pasted 2 lines.txt");
  expect(editedName("Pasted 41 lines.txt", "just one")).toBe("Pasted 1 line.txt");
});

test("an edited file that wasn't a paste keeps its name", () => {
  expect(editedName("notes.txt", "one\ntwo")).toBe("notes.txt");
  expect(editedName("Pasted 3 lines.txt.bak", "one")).toBe("Pasted 3 lines.txt.bak");
});

test("only a paste's own name marks a file as a paste", () => {
  expect(isPasted("Pasted 41 lines.txt")).toBe(true);
  expect(isPasted("Pasted 1 line.txt")).toBe(true);
  expect(isPasted("server.log")).toBe(false);
});
