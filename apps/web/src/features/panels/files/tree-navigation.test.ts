import type { FolderRow } from "@ace/ui-core";
import { expect, test } from "vitest";
import { typeAheadMatch, typingName, type TypeAhead } from "./tree-navigation.ts";

const entry = (name: string, kind: "file" | "folder" = "file"): FolderRow => ({
  key: kind === "folder" ? `${name}/` : name,
  kind,
  name,
  depth: 0,
  expanded: false,
  busy: false,
  ignored: false,
});
const rows = [
  entry("apps", "folder"),
  entry("package.json"),
  entry("pnpm.yaml"),
  entry("README.md"),
];

/** Type `letters` from the row at `index`, `gap` ms apart from `start`; the rows landed on. */
function type(typed: TypeAhead, letters: string, index: number, start: number, gap = 100) {
  return [...letters].map((letter, step) => {
    const match = typeAheadMatch(typed, rows, index, letter, start + step * gap);
    if (match) index = rows.indexOf(match);
    return match?.name;
  });
}

test("letters typed close together spell one name, matched without case", () => {
  const typed = { text: "", at: 0 };
  expect(type(typed, "rea", 0, 5_000)).toEqual(["README.md", "README.md", "README.md"]);
});

test("after a pause of over a second the letters start a new name", () => {
  const typed = { text: "", at: 0 };
  type(typed, "rea", 0, 5_000);
  expect(typeAheadMatch(typed, rows, 3, "a", 5_200 + 1_001)?.name).toBe("apps");
  // Within the pause, "a" carries on the name and nothing matches "reaa".
  const again = { text: "", at: 0 };
  type(again, "rea", 0, 5_000);
  expect(typeAheadMatch(again, rows, 3, "a", 5_200 + 900)).toBeUndefined();
});

test("one letter moves on from the current row and wraps round", () => {
  expect(typeAheadMatch({ text: "", at: 0 }, rows, 1, "p", 5_000)?.name).toBe("pnpm.yaml");
  expect(typeAheadMatch({ text: "", at: 0 }, rows, 2, "p", 5_000)?.name).toBe("package.json");
});

test("a space is part of a name only while one is being typed", () => {
  const typed = { text: "", at: 0 };
  type(typed, "re", 0, 5_000);
  expect(typingName(typed, 5_100 + 500)).toBe(true);
  expect(typingName(typed, 5_100 + 1_001)).toBe(false);
  expect(typingName({ text: "", at: 0 }, 1)).toBe(false);
});
