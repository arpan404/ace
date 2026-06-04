import type { ProviderKind, ProviderSlashCommand } from "@ace/contracts";

export type ProviderExtensionCommandKind = "skill" | "plugin" | "agent";

type ProviderSlashCommandKind = "provider" | ProviderExtensionCommandKind;

export function providerSkillSlashCommand(input: {
  readonly name: string;
  readonly description?: string | undefined;
  readonly promptPrefix?: string | undefined;
  readonly inputHint?: string | undefined;
}): ProviderSlashCommand {
  return {
    name: input.name,
    kind: "skill",
    promptPrefix: input.promptPrefix ?? `$${input.name}`,
    ...(input.description ? { description: input.description } : {}),
    ...(input.inputHint ? { inputHint: input.inputHint } : {}),
  };
}

export function providerPluginSlashCommand(input: {
  readonly name: string;
  readonly description?: string | undefined;
  readonly promptPrefix?: string | undefined;
  readonly inputHint?: string | undefined;
}): ProviderSlashCommand {
  return {
    name: input.name,
    kind: "plugin",
    promptPrefix: input.promptPrefix ?? `@${input.name}`,
    ...(input.description ? { description: input.description } : {}),
    ...(input.inputHint ? { inputHint: input.inputHint } : {}),
  };
}

export function providerAgentSlashCommand(input: {
  readonly name: string;
  readonly description?: string | undefined;
  readonly promptPrefix?: string | undefined;
  readonly inputHint?: string | undefined;
}): ProviderSlashCommand {
  return {
    name: input.name,
    kind: "agent",
    promptPrefix: input.promptPrefix ?? `@${input.name}`,
    ...(input.description ? { description: input.description } : {}),
    ...(input.inputHint ? { inputHint: input.inputHint } : {}),
  };
}

function normalizeProviderCommandKind(value: unknown): ProviderExtensionCommandKind | null {
  return value === "skill" || value === "plugin" || value === "agent" ? value : null;
}

function normalizeProviderSlashCommandKind(value: unknown): ProviderSlashCommandKind | null {
  return value === "provider" || value === "skill" || value === "plugin" || value === "agent"
    ? value
    : null;
}

export function normalizeProviderSlashCommandName(value: string): string | null {
  const name = value.trim().replace(/^[/@$]+/, "");
  if (!name || /\s/.test(name)) {
    return null;
  }
  return name;
}

export function isProviderSideConversationAlias(value: string): boolean {
  const name = normalizeProviderSlashCommandName(value)?.toLowerCase();
  return name === "side" || name === "btw" || name === "ask";
}

export function providerSlashCommandExtensionKind(
  command: ProviderSlashCommand,
  normalizedName: string,
): ProviderExtensionCommandKind | null {
  const declaredKind = normalizeProviderCommandKind(command.kind);
  if (declaredKind) {
    return declaredKind;
  }

  const promptPrefix = command.promptPrefix?.trim();
  if (promptPrefix?.startsWith("$")) {
    return "skill";
  }
  if (promptPrefix?.startsWith("@")) {
    return command.kind === "agent" ? "agent" : "plugin";
  }

  const [root, rest] = normalizedName.split(/[/:.]/u, 2);
  if (!rest) {
    return null;
  }
  const normalizedRoot = root?.toLowerCase();
  if (normalizedRoot === "skill" || normalizedRoot === "skills") {
    return "skill";
  }
  if (normalizedRoot === "plugin" || normalizedRoot === "plugins") {
    return "plugin";
  }
  return null;
}

function comparableExtensionName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function collectPluginCommandKeys(
  sources: ReadonlyArray<ReadonlyArray<ProviderSlashCommand> | null | undefined>,
): Set<string> {
  const pluginKeys = new Set<string>();
  for (const source of sources) {
    for (const candidate of source ?? []) {
      const name = normalizeProviderSlashCommandName(candidate.name);
      if (!name) {
        continue;
      }
      const normalizedKind = normalizeProviderSlashCommandKind(candidate.kind);
      const inferredExtensionKind = providerSlashCommandExtensionKind(candidate, name);
      const kind = normalizedKind ?? inferredExtensionKind;
      if (kind === "plugin") {
        const pluginKey = comparableExtensionName(name);
        if (pluginKey) {
          pluginKeys.add(pluginKey);
        }
      }
    }
  }
  return pluginKeys;
}

function isRedundantPluginPrimarySkillCommand(
  commandName: string,
  pluginCommandKeys: ReadonlySet<string>,
): boolean {
  const [scope, skillName] = commandName.split(":", 2);
  if (!scope || !skillName) {
    return false;
  }
  const pluginKey = comparableExtensionName(scope);
  const skillKey = comparableExtensionName(skillName);
  if (!pluginKey || !skillKey || !pluginCommandKeys.has(pluginKey)) {
    return false;
  }
  return (
    skillKey === pluginKey ||
    pluginKey.startsWith(`${skillKey}-`) ||
    skillKey.startsWith(`${pluginKey}-`)
  );
}

export function mergeProviderSlashCommands(
  ...sources: ReadonlyArray<ReadonlyArray<ProviderSlashCommand> | null | undefined>
): ReadonlyArray<ProviderSlashCommand> {
  const merged: ProviderSlashCommand[] = [];
  const seen = new Set<string>();
  const pluginCommandKeys = collectPluginCommandKeys(sources);

  for (const source of sources) {
    for (const candidate of source ?? []) {
      const name = normalizeProviderSlashCommandName(candidate.name);
      if (!name) {
        continue;
      }
      const normalizedKind = normalizeProviderSlashCommandKind(candidate.kind);
      const inferredExtensionKind = providerSlashCommandExtensionKind(candidate, name);
      const kind = normalizedKind ?? inferredExtensionKind ?? undefined;
      const promptPrefix =
        candidate.promptPrefix?.trim() ||
        (kind === "skill"
          ? `$${name}`
          : kind === "plugin" || kind === "agent"
            ? `@${name}`
            : undefined);

      if (kind === "skill" && isRedundantPluginPrimarySkillCommand(name, pluginCommandKeys)) {
        continue;
      }

      const key = name.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push({
        name,
        ...(candidate.description?.trim() ? { description: candidate.description.trim() } : {}),
        ...(candidate.inputHint?.trim() ? { inputHint: candidate.inputHint.trim() } : {}),
        ...(kind ? { kind } : {}),
        ...(promptPrefix ? { promptPrefix } : {}),
      });
    }
  }

  return merged;
}

const CODEX_SLASH_COMMANDS = [] as const satisfies ReadonlyArray<ProviderSlashCommand>;

const CLAUDE_SLASH_COMMANDS = [] as const satisfies ReadonlyArray<ProviderSlashCommand>;
const GITHUB_COPILOT_SLASH_COMMANDS = [] as const satisfies ReadonlyArray<ProviderSlashCommand>;
const CURSOR_SLASH_COMMANDS = [] as const satisfies ReadonlyArray<ProviderSlashCommand>;
const PI_SLASH_COMMANDS = [] as const satisfies ReadonlyArray<ProviderSlashCommand>;
const GEMINI_SLASH_COMMANDS = [] as const satisfies ReadonlyArray<ProviderSlashCommand>;
const OPENCODE_SLASH_COMMANDS = [] as const satisfies ReadonlyArray<ProviderSlashCommand>;

const FALLBACK_COMMANDS_BY_PROVIDER: Record<ProviderKind, ReadonlyArray<ProviderSlashCommand>> = {
  codex: CODEX_SLASH_COMMANDS,
  claudeAgent: CLAUDE_SLASH_COMMANDS,
  githubCopilot: GITHUB_COPILOT_SLASH_COMMANDS,
  cursor: CURSOR_SLASH_COMMANDS,
  pi: PI_SLASH_COMMANDS,
  gemini: GEMINI_SLASH_COMMANDS,
  opencode: OPENCODE_SLASH_COMMANDS,
};

export function providerFallbackSlashCommands(
  provider: ProviderKind | null | undefined,
): ReadonlyArray<ProviderSlashCommand> {
  return provider ? FALLBACK_COMMANDS_BY_PROVIDER[provider] : [];
}
