import { expect, test } from "vitest";
import { changedFilesText, sourceLine, updateDiff } from "./skill-update.ts";

test("a source reads as where it came from and when it was updated", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  const line = sourceLine({ source: "vercel-labs/skills", updatedAt: "2026-04-23T09:00:00Z" }, now);
  expect(line).toMatch(/^vercel-labs\/skills · updated .*23/);
  expect(line).not.toMatch(/2026/);
  expect(sourceLine({ source: "x/y", updatedAt: "2025-04-23T09:00:00Z" }, now)).toMatch(/2025/);
  expect(sourceLine({ source: "vercel-labs/skills" }, now)).toBe("vercel-labs/skills");
});

test("an update's SKILL.md diff counts the lines it adds and removes", () => {
  const diff = updateDiff("# Skill\n\nOld step.\n", "# Skill\n\nNew step.\nAnother.\n");
  expect([diff.additions, diff.deletions]).toEqual([2, 1]);
  expect(diff.lines.filter((line) => line.kind === "del").map((line) => line.text)).toEqual([
    "Old step.",
  ]);
});

test("the count of changed files is said in words", () => {
  expect(changedFilesText(1)).toBe("1 file changed");
  expect(changedFilesText(3)).toBe("3 files changed");
});
