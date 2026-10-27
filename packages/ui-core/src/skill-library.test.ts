import { expect, test } from "vitest";
import {
  agentsText,
  createdBefore,
  editApplied,
  initialSkillAgents,
  keptAgentsText,
  lockedAgents,
  newSkillPath,
  pluginAgentSet,
  pluginAgentsText,
  pluginOn,
  pluginSwitched,
  runsText,
  groupByHome,
  instructionsShown,
  manualText,
  nameTaken,
  rowMarks,
  skillBody,
  skillNameProblem,
  type PluginPolicy,
} from "./skill-library.ts";

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

test("a new skill starts with the installed agents that have skill folders, or all of them", () => {
  expect(initialSkillAgents(["codex", "antigravity", "claude"])).toEqual(["claude", "codex"]);
  expect(initialSkillAgents(["antigravity"])).toEqual([
    "claude",
    "codex",
    "opencode",
    "cursor",
    "pi",
  ]);
});

test("a new skill is saved in the agents folder of its scope", () => {
  expect(newSkillPath("personal", "notes")).toBe("~/.agents/skills/notes/SKILL.md");
  expect(newSkillPath("project", "notes")).toBe(".agents/skills/notes/SKILL.md");
});

test("agents the daemon left in place are named once, and only when they were asked to go", () => {
  const kept = [{ provider: "codex" as const }, { provider: "claude" as const }];
  expect(keptAgentsText(kept, ["claude"], "Research")).toBe("Codex still sees Research");
  expect(keptAgentsText(kept, [], "Research")).toBe("Claude Code and Codex still see Research");
  expect(keptAgentsText(kept, ["claude", "codex"], "Research")).toBeUndefined();
  expect(keptAgentsText(undefined, [], "Research")).toBeUndefined();
});

const entry = { description: "Release notes", manual: false };
const text = "---\nname: notes\ndescription: Release notes\n---\n# Notes\n\nWrite them.\n";

test("a retried edit counts as saved only when the file already reads as the edit", () => {
  const edit = { description: " Release notes ", body: "# Notes\n\nWrite them.", manual: false };
  expect(editApplied(edit, { entry, text })).toBe(true);
  expect(editApplied({ ...edit, manual: true }, { entry, text })).toBe(false);
  expect(editApplied({ ...edit, body: "# Notes\n\nOther." }, { entry, text })).toBe(false);
  expect(editApplied({ ...edit, description: "Other" }, { entry, text })).toBe(false);
});

test("a retried create finds the skill it made, never another skill of that name", () => {
  const entries = [
    { name: "notes", scope: "project" as const, description: "Release notes" },
    { name: "notes", scope: "personal" as const, description: "Someone else's" },
  ];
  const create = { name: "notes", description: "Release notes", scope: "project" as const };
  expect(createdBefore(entries, create)).toBe(entries[0]);
  expect(createdBefore(entries, { ...create, scope: "personal" })).toBeUndefined();
});

test("Runs says what manual means for the agents that have the skill", () => {
  const agents = [{ provider: "claude" as const, honoursManual: true }];
  expect(runsText({ manual: false, agents })).toBe("Agents load it by themselves when it fits");
  expect(runsText({ manual: true, agents })).toBe("Agents never load it by themselves");
});

test("a skill keeps the agents that read its own folder or hold a copy", () => {
  const presence = { via: "link" as const, path: "", honoursManual: true };
  const agents = [
    { ...presence, provider: "claude" as const, removable: true },
    { ...presence, provider: "codex" as const, removable: false },
  ];
  expect(lockedAgents({ agents })).toEqual(["codex"]);
});

test("a plugin with no agents reads as off, and switching it on gives it every agent", () => {
  const none = { enabled: true, providers: [] };
  expect(pluginOn(none)).toBe(false);
  expect(pluginAgentsText(none)).toBe("Off");
  expect(pluginSwitched(none, true).providers).toEqual([
    "claude",
    "codex",
    "opencode",
    "cursor",
    "antigravity",
    "acp",
    "pi",
  ]);
  const some = { enabled: true, providers: ["codex", "claude"] as const };
  expect(pluginSwitched(some, false)).toEqual({ enabled: false, providers: ["codex", "claude"] });
  expect(pluginAgentsText({ ...some, enabled: false })).toBe("Off");
});

test("ticking agents for a whole plugin keeps app order and reads back as words", () => {
  let policy: PluginPolicy = { enabled: true, providers: ["pi"] };
  policy = pluginAgentSet(policy, "claude", true);
  expect(policy.providers).toEqual(["claude", "pi"]);
  expect(pluginAgentsText(policy)).toBe("On for Claude Code and Pi");
  policy = pluginAgentSet(policy, "pi", false);
  expect(pluginAgentsText(policy)).toBe("On for Claude Code");
  expect(pluginAgentsText(pluginSwitched({ enabled: true, providers: [] }, true))).toBe(
    "On for every agent",
  );
});
