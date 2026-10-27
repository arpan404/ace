import { diffTexts, type DiffText } from "@ace/ui-core";

/*
 * The web's words for the skills library. The shared rules (homes, agents, names, Runs,
 * instructions) live in `@ace/ui-core`'s skill-library, which the phone uses too.
 */
export {
  agentsText,
  groupByHome,
  homeLabel,
  instructionsShown,
  isSkillAgent,
  keptAgentsText,
  lockedAgents,
  manualText,
  initialSkillAgents,
  nameTaken,
  newSkillPath,
  orderedProviders,
  rowMarks,
  runsText,
  skillAgents,
  skillBody,
  skillNameProblem,
  timesText,
  type SkillHome,
} from "@ace/ui-core";

/** "vercel-labs/skills · updated 23 Apr": where a skill came from and when it last changed. */
export function sourceLine(
  source: { source: string; updatedAt?: string | undefined },
  now: number,
) {
  const at = source.updatedAt ? Date.parse(source.updatedAt) : Number.NaN;
  if (Number.isNaN(at)) return source.source;
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  const date = new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `${source.source} · updated ${date}`;
}

/** SKILL.md before and after an update, as a numbered diff of its lines. */
export function updateDiff(before: string, after: string): DiffText {
  const lines = diffTexts(before, after);
  return {
    lines,
    additions: lines.filter((line) => line.kind === "add").length,
    deletions: lines.filter((line) => line.kind === "del").length,
    files: ["SKILL.md"],
    numbered: true,
  };
}
