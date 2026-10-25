import { expect, test } from "vitest";
import {
  agentsText,
  groupByHome,
  instructionsShown,
  rowMarks,
  skillBody,
  skillNameProblem,
  sourceLine,
} from "./library-model.ts";

test("agents read by name, and all of them as every agent", () => {
  expect(agentsText(["claude"])).toBe("Claude Code only");
  expect(agentsText(["opencode", "claude", "codex"])).toBe("Claude Code, Codex and OpenCode");
  expect(agentsText([])).toBe("No agent");
  expect(agentsText(["antigravity", "claude", "codex", "cursor", "opencode", "pi"])).toBe(
    "Every agent",
  );
});

test("a row shows agent marks only when the skill reaches one or two agents", () => {
  expect(rowMarks(["codex"])).toEqual(["codex"]);
  expect(rowMarks(["codex", "claude"])).toEqual(["claude", "codex"]);
  expect(rowMarks(["codex", "claude", "opencode"])).toEqual([]);
  expect(rowMarks([])).toEqual([]);
});

test("skills group by where they live, project first and built-in last, skipping empty groups", () => {
  const groups = groupByHome([
    { name: "b", home: "builtin" as const },
    { name: "p", home: "personal" as const },
    { name: "q", home: "project" as const },
    { name: "p2", home: "personal" as const },
  ]);
  expect(groups.map((group) => [group.home, group.members.map((skill) => skill.name)])).toEqual([
    ["project", ["q"]],
    ["personal", ["p", "p2"]],
    ["builtin", ["b"]],
  ]);
});

test("a new skill's name must be a free slug", () => {
  const taken = (name: string) => name === "release-notes";
  expect(skillNameProblem("", taken)).toBeUndefined();
  expect(skillNameProblem("release-desktop", taken)).toBeUndefined();
  expect(skillNameProblem("Release Notes", taken)).toBe("Use lowercase letters, digits and dashes.");
  expect(skillNameProblem("double--dash", taken)).toBe("Use lowercase letters, digits and dashes.");
  expect(skillNameProblem("release-notes", taken)).toBe(
    "You already have a skill called release-notes.",
  );
});

test("instructions drop the frontmatter and a first heading that repeats the title", () => {
  const text = '---\nname: tdd\ndescription: "Red, green"\n---\n# TDD\n\nWrite the failing test first.\n';
  expect(instructionsShown(text, "TDD")).toBe("Write the failing test first.\n");
  expect(instructionsShown(text, "Testing")).toBe("# TDD\n\nWrite the failing test first.\n");
  expect(skillBody(text)).toBe("# TDD\n\nWrite the failing test first.\n");
});

test("a source reads as where it came from and when it was updated", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  const line = sourceLine({ source: "vercel-labs/skills", updatedAt: "2026-04-23T09:00:00Z" }, now);
  expect(line).toMatch(/^vercel-labs\/skills · updated .*23/);
  expect(line).not.toMatch(/2026/);
  expect(sourceLine({ source: "x/y", updatedAt: "2025-04-23T09:00:00Z" }, now)).toMatch(/2025/);
  expect(sourceLine({ source: "vercel-labs/skills" }, now)).toBe("vercel-labs/skills");
});
