import { expect, test } from "vitest";
import { PathIndex } from "./index.ts";

function indexOf(paths: readonly string[]): PathIndex {
  const index = new PathIndex();
  for (const path of paths) index.update(path, true);
  return index;
}

test("completion finds digits, separators, spaces and non-ASCII characters", () => {
  const index = indexOf([
    "docs/Résumé 2024.md",
    "src/a_b-c.d/x y.ts",
    "src/日本語/ファイル.ts",
    "build/v1.9.0/notes.txt",
  ]);
  expect(index.complete("résumé")).toEqual(["docs/Résumé 2024.md"]);
  expect(index.complete("é 20")).toEqual(["docs/Résumé 2024.md"]);
  expect(index.complete("_-.")).toEqual(["src/a_b-c.d/", "src/a_b-c.d/x y.ts"]);
  expect(index.complete("x y")).toEqual(["src/a_b-c.d/x y.ts"]);
  expect(index.complete("日本ファ")).toEqual(["src/日本語/ファイル.ts"]);
  expect(index.complete("v19")).toEqual(["build/v1.9.0/", "build/v1.9.0/notes.txt"]);
  expect(index.complete("v91")).toEqual([]);
});

test("removed paths stop completing and release their estimated bytes", () => {
  const index = indexOf(["src/main.ts"]);
  const occupied = index.estimatedBytes;
  index.update("src/other.ts", true);
  expect(index.estimatedBytes).toBeGreaterThan(occupied);
  index.update("src/other.ts", false);
  expect(index.estimatedBytes).toBe(occupied);
  expect(index.complete("other")).toEqual([]);
  index.update("src/main.ts", false);
  expect(index.estimatedBytes).toBe(0);
  expect(index.complete("")).toEqual([]);
});
