import { expect, test } from "vitest";
import { codeLines } from "./code-lines.ts";

test("a TypeScript file is coloured by its grammar in both appearances, line by line", async () => {
  const doc = await codeLines(
    'const answer = 42;\nexport function ask() {\n  return "yes";\n}\n',
    "ts",
  );
  expect(doc.lines).toHaveLength(5);
  const keyword = doc.lines[0]?.find((token) => token.text === "const");
  const text = doc.lines[2]?.find((token) => token.text.includes("yes"));
  expect(keyword?.light).toMatch(/^#/);
  expect(keyword?.dark).toMatch(/^#/);
  expect(keyword?.light).not.toBe(keyword?.dark);
  expect(text?.light).toMatch(/^#/);
  expect(text?.light).not.toBe(keyword?.light);
});

test("a language without a grammar still splits into lines, uncoloured", async () => {
  const doc = await codeLines("alpha\nbeta", "brainfork");
  expect(doc.lines.map((line) => line.map((token) => token.text).join(""))).toEqual([
    "alpha",
    "beta",
  ]);
  expect(doc.lines.flat().some((token) => token.light || token.dark)).toBe(false);
});
