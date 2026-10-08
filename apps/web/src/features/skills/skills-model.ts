import {
  ProviderKind,
  type PluginAvailability,
  type PluginComponent,
  type PluginInstall,
  type PluginOrigin,
  type PluginSkillAvailability,
} from "@ace/protocol";
import { extensionDisplayName, providerNames } from "@ace/ui-core";
import { z } from "zod";

/*
 * The Skills catalog from the plugin service: every installed plugin, and the skills, slash
 * commands, agents and rules it ships (`plugins.list` and `plugins.catalog`). A component is
 * on when its plugin is enabled and available to at least one provider.
 */

export const skillsLoadError = "Couldn't load your skills. Check your connection and try again.";

export type SkillKind = PluginComponent["kind"] | "plugin" | "workflow" | "mcp-tool";
export interface Skill {
  discovered?: import("@ace/protocol").CatalogEntry | undefined;
  /** Route id: `plugin~kind~name` for a component, `plugin~name` for a plugin. */
  id: string;
  kind: SkillKind;
  name: string;
  title?: string | undefined;
  description: string;
  /** The plugin that ships it (a plugin's own name for a plugin). */
  plugin: string;
  /** The component's file inside its plugin; undefined for a plugin. */
  path: string | undefined;
  enabled: boolean;
  skillAvailability?: PluginSkillAvailability | undefined;
  providers: readonly ProviderKind[];
  /** A plugin's pin: what was reviewed and accepted. Undefined for a component. */
  install?: PluginPin | undefined;
}

/** The exact version of a plugin that was reviewed and installed. */
export interface PluginPin {
  version: string;
  commit: string;
  acceptedAt: number;
  /** Where it was installed from, when the daemon recorded it. */
  repository?: string | undefined;
  ref?: string | undefined;
}

export const pluginSkillId = (name: string) => `plugin~${name}`;
export const componentSkillId = (component: Pick<PluginComponent, "plugin" | "kind" | "name">) =>
  `${component.plugin}~${component.kind}~${component.name}`;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const kindNames: Record<PluginComponent["kind"], [string, string]> = {
  skill: ["skill", "skills"],
  command: ["command", "commands"],
  agent: ["agent", "agents"],
  rule: ["rule", "rules"],
};

function shippedCounts(components: readonly { kind: SkillKind }[]): string[] {
  return (Object.keys(kindNames) as PluginComponent["kind"][]).flatMap((kind) => {
    const count = components.filter((component) => component.kind === kind).length;
    return count ? [plural(count, ...kindNames[kind])] : [];
  });
}

/** "Version 2.3.0 · 3 skills, 1 command". */
function pluginDescription(install: PluginInstall, components: readonly PluginComponent[]) {
  return [`Version ${install.version}`, shippedCounts(components).join(", ")]
    .filter(Boolean)
    .join(" · ");
}

/** "3 skills, 1 command and 1 agent", or undefined when it ships nothing. */
export function shippedText(components: readonly { kind: SkillKind }[]) {
  const counts = shippedCounts(components);
  if (!counts.length) return undefined;
  return counts.length === 1 ? counts[0] : `${counts.slice(0, -1).join(", ")} and ${counts.at(-1)}`;
}

/** The components `plugin` ships, in catalog order. */
export function componentsOf(skills: readonly Skill[], plugin: string): Skill[] {
  return skills.filter((skill) => skill.plugin === plugin && skill.kind !== "plugin");
}

/** A readable title when the package only supplies a command name. */
export function skillTitle(
  skill: Pick<Skill, "name" | "title"> & Partial<Pick<Skill, "kind" | "plugin">>,
): string {
  return extensionDisplayName(
    skill.name,
    skill.title,
    skill.kind === "agent" ? skill.plugin : undefined,
  );
}

/** Metadata belongs to the package; the preview shows the instruction body. */
export function skillMarkdown(text: string, skill?: Skill): string {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  return skill
    ? body.replace(/^# (.+)$/m, (heading, name: string) =>
        name === skill.name ? `# ${skillTitle(skill)}` : heading,
      )
    : body;
}

/** The installed version and date, without internal commit identifiers. */
export function pinText(pin: PluginPin, now: number): string {
  const accepted = new Date(pin.acceptedAt);
  const sameYear = accepted.getFullYear() === new Date(now).getFullYear();
  const date = accepted.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `Version ${pin.version} · installed ${date}`;
}

/** "getsentry/sentry @ main": a repository as people type it, with its ref. */
export function sourceText(repository: string, ref: string | undefined): string {
  const short = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(repository)?.[1];
  const where = short ?? repository;
  return ref && ref !== "HEAD" ? `${where} @ ${ref}` : where;
}

/** Every component the catalog lists, then each installed plugin by name. */
export function skillCatalog(
  installs: readonly PluginInstall[],
  availability: readonly PluginAvailability[],
  components: readonly PluginComponent[],
  origins: readonly PluginOrigin[] = [],
): Skill[] {
  const policy = new Map(availability.map((entry) => [entry.name, entry]));
  const from = new Map(origins.map((origin) => [origin.name, origin]));
  const plugins = installs
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((install): Skill => {
      const own = components.filter((component) => component.plugin === install.name);
      const entry = policy.get(install.name);
      return {
        id: pluginSkillId(install.name),
        kind: "plugin",
        name: install.name,
        description: pluginDescription(install, own),
        plugin: install.name,
        path: undefined,
        enabled: (entry?.enabled ?? true) && (entry?.providers.length ?? 1) > 0,
        providers: entry?.providers ?? ProviderKind.options,
        install: {
          version: install.version,
          commit: install.commit,
          acceptedAt: install.acceptedAt,
          repository: from.get(install.name)?.repository,
          ref: from.get(install.name)?.ref,
        },
      };
    });
  const shipped = components.map((component): Skill => ({
    id: componentSkillId(component),
    kind: component.kind,
    name: component.name,
    title: component.title,
    description: component.description,
    plugin: component.plugin,
    path: component.path,
    enabled: component.enabled && component.providers.length > 0,
    skillAvailability: component.skillAvailability,
    providers: component.providers,
  }));
  return [...shipped, ...plugins];
}

/** "Every provider", or the providers by name: "Claude Code and Codex". */
export function availabilityText(providers: readonly ProviderKind[]): string {
  if (!providers.length) return "No provider";
  if (ProviderKind.options.every((provider) => providers.includes(provider)))
    return "Every provider";
  const names = ProviderKind.options
    .filter((provider) => providers.includes(provider))
    .map((provider) => providerNames[provider]);
  return names.length === 1
    ? `${names[0]} only`
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Where a plugin comes from: `owner/name` (GitHub), an https or ssh git URL, or an absolute
 * path to a local repository. The daemon fetches it with git and reads its marketplace.
 */
export const PluginRepository = z
  .string()
  .trim()
  .min(1, "Enter a repository.")
  .refine(
    (value) =>
      /^[\w.-]+\/[\w.-]+$/.test(value) ||
      /^(https:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)\S+$/.test(value) ||
      value.startsWith("/"),
    "Use owner/name, a git URL, or an absolute path to a local repository.",
  )
  .transform((value) =>
    /^[\w.-]+\/[\w.-]+$/.test(value) ? `https://github.com/${value}.git` : value,
  );

/** A branch, tag or commit, as git accepts it for a fetch. */
export const PluginRef = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,255}$/, "Use a branch, tag or commit.")
  .refine((value) => !value.includes(".."), "Use a branch, tag or commit.");

/** The plugin's name in the repository's marketplace. */
export const PluginNameInput = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/,
    "Use the plugin's name from the marketplace: lowercase letters, digits, dots and dashes.",
  )
  .max(64, "Plugin names are at most 64 characters.")
  .refine((value) => !value.includes("..") && !value.includes("--"), "That isn't a plugin name.");

/** "getsentry/sentry-mcp" → "sentry-mcp": the name a repository's plugin most likely has. */
export function suggestedPluginName(repository: string): string {
  return (
    repository
      .trim()
      .replace(/\.git$/, "")
      .split(/[/:]/)
      .at(-1)
      ?.toLowerCase()
      .replace(/[^a-z0-9.-]/g, "-") ?? ""
  );
}
