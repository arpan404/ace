import {
  ProviderKind,
  type PluginAvailability,
  type PluginComponent,
  type PluginInstall,
} from "@ace/protocol";
import { providerNames } from "@ace/ui-core";
import { z } from "zod";

/*
 * The Skills catalog from the plugin service: every installed plugin, and the skills, slash
 * commands, agents and rules it ships (`plugins.list` and `plugins.catalog`). A component is
 * on when its plugin is enabled and available to at least one provider.
 */

export type SkillKind = PluginComponent["kind"] | "plugin";
export interface Skill {
  /** Route id: `plugin~kind~name` for a component, `plugin~name` for a plugin. */
  id: string;
  kind: SkillKind;
  name: string;
  description: string;
  /** The plugin that ships it (a plugin's own name for a plugin). */
  plugin: string;
  /** The component's file inside its plugin; undefined for a plugin. */
  path: string | undefined;
  enabled: boolean;
  providers: readonly ProviderKind[];
  /** A plugin's pin: what was reviewed and accepted. Undefined for a component. */
  install?: PluginPin | undefined;
}

/** The exact version of a plugin that was reviewed and installed. */
export interface PluginPin {
  version: string;
  commit: string;
  acceptedAt: number;
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

/**
 * The catalog as it reads once `plugin` has this availability: the plugin and everything it
 * ships follow it. Used to show a change at once, before the daemon confirms it.
 */
export function withAvailability(
  skills: readonly Skill[],
  plugin: string,
  next: { enabled: boolean; providers: readonly ProviderKind[] },
): Skill[] {
  const enabled = next.enabled && next.providers.length > 0;
  return skills.map((skill) =>
    skill.plugin === plugin ? { ...skill, enabled, providers: next.providers } : skill,
  );
}

/** "Version 2.3.0 · pinned b1c2d3e4f5a6 · installed 12 Sep". */
export function pinText(pin: PluginPin, now: number): string {
  const accepted = new Date(pin.acceptedAt);
  const sameYear = accepted.getFullYear() === new Date(now).getFullYear();
  const date = accepted.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `Version ${pin.version} · pinned ${pin.commit.slice(0, 12)} · installed ${date}`;
}

/** Every component the catalog lists, then each installed plugin by name. */
export function skillCatalog(
  installs: readonly PluginInstall[],
  availability: readonly PluginAvailability[],
  components: readonly PluginComponent[],
): Skill[] {
  const policy = new Map(availability.map((entry) => [entry.name, entry]));
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
        },
      };
    });
  const shipped = components.map((component): Skill => ({
    id: componentSkillId(component),
    kind: component.kind,
    name: component.name,
    description: component.description,
    plugin: component.plugin,
    path: component.path,
    enabled: component.enabled && component.providers.length > 0,
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
