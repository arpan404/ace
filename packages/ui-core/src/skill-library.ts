import { ProviderKind, SkillAgent, type SkillEntry, type SkillPresence } from "@ace/protocol";
import { providerNames } from "./providers.ts";

/*
 * The skill library (ADR 0103) as people read it, for the web's Skills pages and the phone's:
 * where a skill lives, which agents see it, the words for both, and the rules a new or edited
 * skill must meet. Pure: no I/O, no clock.
 */

/** Where a skill lives: the open project, the person's own folder, a plugin, or ace itself. */
export type SkillHome = "project" | "personal" | "plugin" | "builtin";

const homeOrder: readonly SkillHome[] = ["project", "personal", "plugin", "builtin"];

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

/** The groups that have members, in list order; members keep their given order. */
export function groupByHome<T extends { home: SkillHome }>(
  skills: readonly T[],
): { home: SkillHome; members: T[] }[] {
  return homeOrder
    .map((home) => ({ home, members: skills.filter((skill) => skill.home === home) }))
    .filter((group) => group.members.length > 0);
}

/**
 * The marks a row carries: a skill that reaches one or two agents shows them; one that reaches
 * more (or none) shows nothing, so a row only speaks up when it is narrow.
 */
export function rowMarks(providers: readonly ProviderKind[]): ProviderKind[] {
  const ordered = orderedProviders(providers);
  return ordered.length > 0 && ordered.length <= 2 ? ordered : [];
}

/** The agents with skill folders of their own (ADR 0103); others receive skills through ace. */
export const skillAgents: readonly SkillAgent[] = SkillAgent.options;

/** Whether ace can give this agent a skill by linking it into the agent's folder. */
export const isSkillAgent = (provider: ProviderKind): provider is SkillAgent =>
  SkillAgent.safeParse(provider).success;

/** Agent order as everywhere else in the app, whatever order they were picked in. */
export const orderedProviders = (providers: readonly ProviderKind[]): ProviderKind[] =>
  ProviderKind.options.filter((provider) => providers.includes(provider));

const namesText = (names: readonly string[]) =>
  names.length === 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** "Every agent", "Codex only", "Claude Code, Codex and OpenCode". */
export function agentsText(providers: readonly ProviderKind[]): string {
  const names = orderedProviders(providers).map((provider) => providerNames[provider]);
  if (!names.length) return "No agent";
  if (skillAgents.every((provider) => providers.includes(provider))) return "Every agent";
  return names.length === 1 ? `${names[0]} only` : namesText(names);
}

/**
 * What "Only when picked" means for the agents that have the skill. Codex and OpenCode ignore
 * the frontmatter flag (ADR 0103 "Manual skills"), so the words never promise more than they do.
 */
export function manualText(agents: readonly Pick<SkillPresence, "provider" | "honoursManual">[]) {
  const names = (honours: boolean) =>
    orderedProviders(
      agents.filter((agent) => agent.honoursManual === honours).map((agent) => agent.provider),
    ).map((provider) => providerNames[provider]);
  const honouring = names(true);
  const ignoring = names(false);
  if (!ignoring.length) return "Agents never load it by themselves";
  const still = `${namesText(ignoring)} may still load it.`;
  if (!honouring.length) return still;
  const itself =
    honouring.length === 1 ? "never loads it by itself" : "never load it by themselves";
  return `${namesText(honouring)} ${itself}. ${still}`;
}

/** The Runs line under a skill: when agents load it. */
export function runsText(entry: Pick<SkillEntry, "manual" | "agents">): string {
  return entry.manual ? manualText(entry.agents) : "Agents load it by themselves when it fits";
}

/** Runs' two choices, in the order they are offered. */
export const runsChoices = [
  { manual: false, label: "When it fits" },
  { manual: true, label: "Only when picked" },
] as const;

/** Whether the daemon would refuse this name: a native skill of that name in the chosen scope. */
export function nameTaken(
  entries: readonly { name: string; scope: string }[] | undefined,
  name: string,
  scope: "personal" | "project",
): boolean {
  return !!entries?.some((entry) => entry.name === name && entry.scope === scope);
}

const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Why a new skill's name can't be used, or undefined when it can. Empty is not an error yet. */
export function skillNameProblem(name: string, taken: (name: string) => boolean) {
  const value = name.trim();
  if (!value) return undefined;
  if (!slug.test(value) || value.length > 64) return "Use lowercase letters, digits and dashes.";
  if (taken(value)) return `You already have a skill called ${value}.`;
  return undefined;
}

/** Where the daemon saves a new skill (ADR 0103), as a form previews it. */
export const newSkillPath = (scope: "personal" | "project", name: string) =>
  `${scope === "personal" ? "~/" : ""}.agents/skills/${name}/SKILL.md`;

/** A new skill's agents before the person picks: the installed ones, or all when none are. */
export function initialSkillAgents(installed: readonly ProviderKind[]): SkillAgent[] {
  const chosen = skillAgents.filter((agent) => installed.includes(agent));
  return chosen.length ? chosen : [...skillAgents];
}

/** Agents a skill keeps whatever is asked: they read its own folder, or keep a copy. */
export function lockedAgents(entry: Pick<SkillEntry, "agents">): SkillAgent[] {
  return entry.agents.filter((agent) => !agent.removable).map((agent) => agent.provider);
}

/**
 * After a change of agents, the ones asked to go that the daemon left in place:
 * "Codex still sees Research", or undefined when every asked change happened.
 */
export function keptAgentsText(
  kept: readonly { provider: SkillAgent }[] | undefined,
  asked: readonly ProviderKind[],
  title: string,
): string | undefined {
  const left = orderedProviders(
    (kept ?? []).map((each) => each.provider).filter((provider) => !asked.includes(provider)),
  );
  if (!left.length) return undefined;
  const names = namesText(left.map((provider) => providerNames[provider]));
  return `${names} still ${left.length === 1 ? "sees" : "see"} ${title}`;
}

/** "Once", "6 times". */
export const timesText = (count: number) => (count === 1 ? "Once" : `${count} times`);

/** SKILL.md without its frontmatter: the instructions an edit replaces. */
export function skillBody(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}

/** The instructions as a page shows them: a first heading repeating the title goes. */
export function instructionsShown(text: string, title: string): string {
  const body = skillBody(text);
  const heading = /^\s*#\s+(.+?)\s*(?:\r?\n|$)/.exec(body);
  return heading && heading[1]?.toLowerCase() === title.toLowerCase()
    ? body.slice(heading[0].length).replace(/^\s+/, "")
    : body;
}

/** What an edit sends: the parts of SKILL.md a person changes. The name never changes. */
export interface SkillEdit {
  description: string;
  body: string;
  manual: boolean;
}

/**
 * Whether the file already holds `edit`. An edit whose answer was lost (the connection dropped)
 * is sent again; the daemon then refuses it as a conflict, since the hash moved when it applied.
 * When the file reads as the edit asked, it did apply, and the retry is a success.
 */
export function editApplied(
  edit: SkillEdit,
  now: { entry: Pick<SkillEntry, "description" | "manual">; text: string },
): boolean {
  return (
    now.entry.description === edit.description.trim() &&
    now.entry.manual === edit.manual &&
    skillBody(now.text).trimEnd() === edit.body.trimEnd()
  );
}

/**
 * The skill a lost create made, when its retry is refused with `exists`: the entry of that name
 * in that scope with the description sent. Undefined when the name belongs to another skill.
 */
export function createdBefore<T extends Pick<SkillEntry, "name" | "scope" | "description">>(
  entries: readonly T[],
  create: { name: string; description: string; scope: "personal" | "project" },
): T | undefined {
  return entries.find(
    (entry) =>
      entry.name === create.name &&
      entry.scope === create.scope &&
      entry.description === create.description.trim(),
  );
}

/** A plugin's availability: on or off, and the agents that may load what it ships. */
export interface PluginPolicy {
  enabled: boolean;
  providers: readonly ProviderKind[];
}

/** Whether a plugin reaches any agent: switched on, with at least one agent ticked. */
export const pluginOn = (policy: PluginPolicy) => policy.enabled && policy.providers.length > 0;

/** Turning a plugin on or off. Turning on one with no agents gives it every agent again. */
export function pluginSwitched(policy: PluginPolicy, enabled: boolean): PluginPolicy {
  return {
    enabled,
    providers:
      enabled && !policy.providers.length ? [...ProviderKind.options] : [...policy.providers],
  };
}

/** Ticking or unticking one agent for a whole plugin, in app order. */
export function pluginAgentSet(
  policy: PluginPolicy,
  provider: ProviderKind,
  on: boolean,
): PluginPolicy {
  const rest = policy.providers.filter((each) => each !== provider);
  return { enabled: policy.enabled, providers: orderedProviders(on ? [...rest, provider] : rest) };
}

/** "On for Claude Code and Codex", "On for every agent", "Off", for a plugin's row. */
export function pluginAgentsText(policy: PluginPolicy): string {
  if (!pluginOn(policy)) return "Off";
  if (ProviderKind.options.every((provider) => policy.providers.includes(provider)))
    return "On for every agent";
  const names = orderedProviders(policy.providers).map((provider) => providerNames[provider]);
  return `On for ${namesText(names)}`;
}
