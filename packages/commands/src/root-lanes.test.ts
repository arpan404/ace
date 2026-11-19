import { join } from "node:path";
import { expect, it } from "vitest";
import { builtinSkillsRoot, discoveryRoots } from "./roots.ts";
import { commandLaneOf } from "./secure-io.ts";
import { skillRootLane, skillRoots } from "./skill-roots.ts";

const home = "/home/person";
const workspace = "/work/project";
const homes = {
  home,
  claude: join(home, ".claude"),
  codex: join(home, ".codex"),
  opencode: join(home, ".config/opencode"),
  cursor: join(home, ".cursor"),
  pi: join(home, ".pi/agent"),
};

it("a skill folder that discovery and the skill library both reach is one lane", () => {
  const discovered = discoveryRoots(
    [
      { id: "claude", provider: "claude", home: homes.claude, skillsHome: home },
      { id: "codex", provider: "codex", home: homes.codex, skillsHome: home },
    ],
    join(home, ".ace"),
    workspace,
  );
  const library = skillRoots(homes, workspace);
  const shared = library.filter((root) => discovered.some((d) => d.path === root.path));
  // Personal, shared `.agents` and project folders, each anchored differently for containment.
  expect(shared.map((root) => root.path)).toEqual(
    expect.arrayContaining([
      join(homes.claude, "skills"),
      join(home, ".agents/skills"),
      join(workspace, ".claude/skills"),
      join(workspace, ".agents/skills"),
    ]),
  );
  for (const root of shared)
    for (const found of discovered.filter((d) => d.path === root.path))
      expect(commandLaneOf(found)).toBe(skillRootLane(root));
});

it("ace's shipped skills are one lane for discovery and the library", () => {
  const directory = "/opt/ace/builtin-skills";
  expect(commandLaneOf(builtinSkillsRoot(directory))).toBe(
    skillRootLane({ path: directory, scope: "personal", readers: [], linkFor: [] }),
  );
});
