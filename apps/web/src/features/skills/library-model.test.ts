import { expect, test } from "vitest";
import {
  agentsText,
  groupByHome,
  instructionsShown,
  manualText,
  nameTaken,
  rowMarks,
  skillBody,
  skillNameProblem,
  sourceLine,
} from "./library-model.ts";

test("agents read by name, and all of them as every agent", () => {
  expect(agentsText(["claude"])).toBe("Claude Code only");
  expect(agentsText(["opencode", "claude", "codex"])).toBe("Claude Code, Codex and OpenCode");
  expect(agentsText([])).toBe("No agent");
  expect(agentsText(["claude", "codex", "cursor", "opencode", "pi"])).toBe("Every agent");
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

const taken = (name: string) => name === "release-notes";

test("a new skill's name must be a free slug", () => {
  expect(skillNameProblem("", taken)).toBeUndefined();
  expect(skillNameProblem("release-desktop", taken)).toBeUndefined();
  expect(skillNameProblem("Release Notes", taken)).toBe(
    "Use lowercase letters, digits and dashes.",
  );
  expect(skillNameProblem("double--dash", taken)).toBe("Use lowercase letters, digits and dashes.");
  expect(skillNameProblem("release-notes", taken)).toBe(
    "You already have a skill called release-notes.",
  );
});

test("a new name clashes only with a skill in the folder it would be saved to", () => {
  const entries = [
    { name: "review", scope: "builtin" },
    { name: "deploy", scope: "plugin" },
    { name: "notes", scope: "project" },
    { name: "research", scope: "personal" },
  ];
  expect(nameTaken(entries, "review", "personal")).toBe(false);
  expect(nameTaken(entries, "deploy", "project")).toBe(false);
  expect(nameTaken(entries, "notes", "personal")).toBe(false);
  expect(nameTaken(entries, "notes", "project")).toBe(true);
  expect(nameTaken(entries, "research", "personal")).toBe(true);
  expect(nameTaken(undefined, "research", "personal")).toBe(false);
});

test("a manual skill promises not to load by itself only for agents that honour it", () => {
  const claude = { provider: "claude", honoursManual: true } as const;
  const cursor = { provider: "cursor", honoursManual: true } as const;
  const codex = { provider: "codex", honoursManual: false } as const;
  const opencode = { provider: "opencode", honoursManual: false } as const;
  expect(manualText([claude, cursor])).toBe("Agents never load it by themselves");
  expect(manualText([opencode, claude, codex])).toBe(
    "Claude Code never loads it by itself. Codex and OpenCode may still load it.",
  );
  expect(manualText([claude, cursor, codex])).toBe(
    "Claude Code and Cursor never load it by themselves. Codex may still load it.",
  );
  expect(manualText([codex, { ...codex }])).toBe("Codex may still load it.");
});

test("instructions drop the frontmatter and a first heading that repeats the title", () => {
  const text =
    '---\nname: tdd\ndescription: "Red, green"\n---\n# TDD\n\nWrite the failing test first.\n';
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
