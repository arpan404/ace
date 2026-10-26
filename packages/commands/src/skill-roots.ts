import { join } from "node:path";
import type { SkillAgent } from "@ace/protocol";

/** Agents in display order. ACP and Antigravity have no skill folder (ADR 0103). */
export const skillAgents: readonly SkillAgent[] = ["claude", "codex", "opencode", "cursor", "pi"];
/** Agents that honour `disable-model-invocation: true` (ADR 0103 "Manual skills"). */
export const honoursManual: Readonly<Record<SkillAgent, boolean>> = {
  claude: true,
  codex: false,
  opencode: false,
  cursor: true,
  pi: true,
};

/** A folder of `<name>/SKILL.md` directories that ace may write in. */
export interface SkillRoot {
  path: string;
  scope: "personal" | "project";
  /** Agents that load skills from this folder. */
  readers: readonly SkillAgent[];
  /** Agents for which ace adds links here. */
  linkFor: readonly SkillAgent[];
}
/** Personal agent homes, from the same defaults the catalog uses (`defaultCommandInstances`). */
export interface SkillHomes {
  /** The person's home directory. */
  home: string;
  claude: string;
  codex: string;
  opencode: string;
  cursor: string;
  pi: string;
}
/**
 * Where each agent reads skills, from its documentation (table in ADR 0103). The per-provider
 * folders match `discoveryRoots`; the shared `.agents`, `.claude` and `.codex` readers are the
 * cross-agent compatibility each agent documents.
 */
export function skillRoots(homes: SkillHomes, workspace?: string): SkillRoot[] {
  const literalClaude = join(homes.home, ".claude/skills");
  const literalCodex = join(homes.home, ".codex/skills");
  const personal: SkillRoot[] = [
    {
      path: join(homes.home, ".agents/skills"),
      scope: "personal",
      readers: ["codex", "opencode", "cursor", "pi"],
      linkFor: ["codex"],
    },
    {
      path: join(homes.claude, "skills"),
      scope: "personal",
      readers:
        join(homes.claude, "skills") === literalClaude
          ? ["claude", "opencode", "cursor"]
          : ["claude"],
      linkFor: ["claude"],
    },
    {
      path: join(homes.codex, "skills"),
      scope: "personal",
      readers: join(homes.codex, "skills") === literalCodex ? ["codex", "cursor"] : ["codex"],
      linkFor: [],
    },
    {
      path: join(homes.opencode, "skills"),
      scope: "personal",
      readers: ["opencode"],
      linkFor: ["opencode"],
    },
    {
      path: join(homes.cursor, "skills"),
      scope: "personal",
      readers: ["cursor"],
      linkFor: ["cursor"],
    },
    { path: join(homes.pi, "skills"), scope: "personal", readers: ["pi"], linkFor: ["pi"] },
  ];
  // A relocated CLAUDE_CONFIG_DIR or CODEX_HOME still leaves the literal folders other agents read.
  if (join(homes.claude, "skills") !== literalClaude)
    personal.push({
      path: literalClaude,
      scope: "personal",
      readers: ["opencode", "cursor"],
      linkFor: [],
    });
  if (join(homes.codex, "skills") !== literalCodex)
    personal.push({ path: literalCodex, scope: "personal", readers: ["cursor"], linkFor: [] });
  if (!workspace) return personal;
  const project = (folder: string, readers: SkillAgent[], linkFor: SkillAgent[]): SkillRoot => ({
    path: join(workspace, folder),
    scope: "project",
    readers,
    linkFor,
  });
  return [
    ...personal,
    project(".agents/skills", ["codex", "opencode", "cursor", "pi"], ["codex"]),
    project(".claude/skills", ["claude", "opencode", "cursor"], ["claude"]),
    project(".codex/skills", ["codex", "cursor"], []),
    project(".opencode/skills", ["opencode"], ["opencode"]),
    project(".cursor/skills", ["cursor"], ["cursor"]),
    project(".pi/skills", ["pi"], ["pi"]),
  ];
}
/** Where new skills are saved: the shared Agent Skills folder. */
export function canonicalRoot(roots: readonly SkillRoot[], scope: SkillRoot["scope"]): SkillRoot {
  const root = roots.find((r) => r.scope === scope && r.linkFor.includes("codex"));
  if (!root) throw new Error("skill_root_missing");
  return root;
}
