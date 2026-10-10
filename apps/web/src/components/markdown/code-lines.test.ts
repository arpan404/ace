import { expect, test } from "vitest";
import { codeHash, codeLines, codeLinesWeight } from "./code-lines.ts";
import { sourceHighlight } from "./source-highlight.ts";

test("token-dense source crosses the worker boundary as a compact cached plain result", async () => {
  const source =
    "export const n=42; // note\n".repeat(22_000) + "\n// exact trailing whitespace  \n";
  const hash = codeHash(source, "typescript");
  const colored = await sourceHighlight(source, "typescript");
  if (!colored) throw new Error("Expected TypeScript grammar output");
  const rich = { hash, lines: colored };
  expect(codeLinesWeight(rich)).toBeGreaterThan(8 * 1024 * 1024);
  const result = await codeLines(source, "typescript");
  expect(result).toEqual({ hash, plain: true });
  expect(codeLinesWeight(result)).toBe(64);
  expect(JSON.stringify(result).length).toBeLessThan(JSON.stringify(rich).length / 4);
  expect(await codeLines(source, "typescript")).toBe(result);
});

test("ordinary source retains syntax colors and exact line endings", async () => {
  const source = "// comment\nexport const answer = 'hello';\n\n";
  const result = await codeLines(source, "typescript");
  if (!("lines" in result)) throw new Error("Ordinary source must retain colors");
  expect(result.lines.map((line) => line.map((token) => token.text).join("")).join("\n")).toBe(
    source,
  );
  expect(
    new Set(result.lines.flatMap((line) => line.map((token) => token.light).filter(Boolean))).size,
  ).toBeGreaterThan(2);
  expect(result.lines.at(-1)).toEqual([]);
});

test("newline-heavy source returns no per-line graph and caches its compact plain result", async () => {
  const source = "\n".repeat(1_048_576);
  const result = await codeLines(source, "typescript");
  expect(result).toEqual({ hash: codeHash(source, "typescript"), plain: true });
  expect(codeLinesWeight(result)).toBe(64);
  expect(JSON.stringify(result).length).toBeLessThan(100);
  expect(await codeLines(source, "typescript")).toBe(result);
});
