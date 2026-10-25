import { ProviderKind, SkillAgent } from "@ace/protocol";
import { diffTexts, providerNames, type DiffText } from "@ace/ui-core";

/*
 * The skills library as the sidebar and pages read it: where a skill lives, which agents see
 * it, and the words for both. Pure: no I/O, no clock.
 */

/** Where a skill lives: the open project, the person's own folder, a plugin, or ace itself. */
export type SkillHome = "project" | "personal" | "plugin" | "builtin";

export const homeOrder: readonly SkillHome[] = ["project", "personal", "plugin", "builtin"];

/** "ace project", "Personal", "Plugins", "Built into ace". */
export function homeLabel(home: SkillHome, project: string | undefined): string {
  switch (home) {
    case "project":
      return project ? `${project} project` : "Project";
    case "personal":
      return "Personal";
    case "plugin":
      return "Plugins";
    case "builtin":
      return "Built into ace";
  }
}

/** The groups that have members, in sidebar order; members keep their given order. */
export function groupByHome<T extends { home: SkillHome }>(
  skills: readonly T[],
): { home: SkillHome; members: T[] }[] {
  return homeOrder
    .map((home) => ({ home, members: skills.filter((skill) => skill.home === home) }))
    .filter((group) => group.members.length > 0);
}

/**
 * The marks a sidebar row carries: a skill that reaches one or two agents shows them; one that
 * reaches more (or none) shows nothing, so a row only speaks up when it is narrow.
 */
export function rowMarks(providers: readonly ProviderKind[]): ProviderKind[] {
  const ordered = ProviderKind.options.filter((provider) => providers.includes(provider));
  return ordered.length > 0 && ordered.length <= 2 ? ordered : [];
}

/** The agents with skill folders of their own (ADR 0103); others receive skills through ace. */
export const skillAgents: readonly SkillAgent[] = SkillAgent.options;

/** Whether ace can give this agent a skill by linking it into the agent's folder. */
export const isSkillAgent = (provider: ProviderKind): provider is SkillAgent =>
  SkillAgent.safeParse(provider).success;

/** "Every agent", "Codex only", "Claude Code, Codex and OpenCode". */
export function agentsText(providers: readonly ProviderKind[]): string {
  const names = ProviderKind.options
    .filter((provider) => providers.includes(provider))
    .map((provider) => providerNames[provider]);
  if (!names.length) return "No agent";
  if (skillAgents.every((provider) => providers.includes(provider))) return "Every agent";
  return names.length === 1
    ? `${names[0]} only`
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Agent order as everywhere else in the app, whatever order they were picked in. */
export const orderedProviders = (providers: readonly ProviderKind[]): ProviderKind[] =>
  ProviderKind.options.filter((provider) => providers.includes(provider));

const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Why a new skill's name can't be used, or undefined when it can. Empty is not an error yet. */
export function skillNameProblem(name: string, taken: (name: string) => boolean) {
  const value = name.trim();
  if (!value) return undefined;
  if (!slug.test(value) || value.length > 64) return "Use lowercase letters, digits and dashes.";
  if (taken(value)) return `You already have a skill called ${value}.`;
  return undefined;
}

/** "Once", "6 times". */
export const timesText = (count: number) => (count === 1 ? "Once" : `${count} times`);

/** "vercel-labs/skills · updated 23 Apr": where a skill came from and when it last changed. */
export function sourceLine(source: { source: string; updatedAt?: string | undefined }, now: number) {
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

/** SKILL.md without its frontmatter: the instructions an edit replaces. */
export function skillBody(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}

/** The instructions as the page shows them: a first heading repeating the title goes. */
export function instructionsShown(text: string, title: string): string {
  const body = skillBody(text);
  const heading = /^\s*#\s+(.+?)\s*(?:\r?\n|$)/.exec(body);
  return heading && heading[1]?.toLowerCase() === title.toLowerCase()
    ? body.slice(heading[0].length).replace(/^\s+/, "")
    : body;
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
