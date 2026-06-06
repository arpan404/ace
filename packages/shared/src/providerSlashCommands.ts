import type { ProviderKind, ProviderSlashCommand } from "@ace/contracts";
import { providerAgentMetadataFromRecord, providerAgentRecord } from "./providerAgentMetadata";

export type ProviderExtensionCommandKind = "skill" | "plugin" | "agent";

type ProviderSlashCommandKind = "provider" | ProviderExtensionCommandKind;

export function providerSkillSlashCommand(input: {
  readonly name: string;
  readonly description?: string | undefined;
  readonly promptPrefix?: string | undefined;
  readonly inputHint?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}): ProviderSlashCommand {
  return {
    name: input.name,
    kind: "skill",
    promptPrefix: input.promptPrefix ?? `$${input.name}`,
    ...(input.description ? { description: input.description } : {}),
    ...(input.inputHint ? { inputHint: input.inputHint } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

export function providerPluginSlashCommand(input: {
  readonly name: string;
  readonly description?: string | undefined;
  readonly promptPrefix?: string | undefined;
  readonly inputHint?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}): ProviderSlashCommand {
  return {
    name: input.name,
    kind: "plugin",
    promptPrefix: input.promptPrefix ?? `@${input.name}`,
    ...(input.description ? { description: input.description } : {}),
    ...(input.inputHint ? { inputHint: input.inputHint } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

export function providerAgentSlashCommand(input: {
  readonly name: string;
  readonly description?: string | undefined;
  readonly promptPrefix?: string | undefined;
  readonly inputHint?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}): ProviderSlashCommand {
  return {
    name: input.name,
    kind: "agent",
    promptPrefix: input.promptPrefix ?? `@${input.name}`,
    ...(input.description ? { description: input.description } : {}),
    ...(input.inputHint ? { inputHint: input.inputHint } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
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

function providerCommandMetadataRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizedMetadataText(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value
        .trim()
        .toLowerCase()
        .replace(/^[./@$/]+/, "")
        .replace(/[_\s]+/g, "-")
    : null;
}

function providerCommandMetadataStringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => providerCommandMetadataStringList(entry));
  }
  const record = providerCommandMetadataRecord(value);
  if (!record) {
    return [];
  }
  const directName =
    typeof record.name === "string" && record.name.trim()
      ? record.name.trim()
      : typeof record.id === "string" && record.id.trim()
        ? record.id.trim()
        : typeof record.label === "string" && record.label.trim()
          ? record.label.trim()
          : typeof record.value === "string" && record.value.trim()
            ? record.value.trim()
            : null;
  if (directName) {
    return [directName];
  }
  return Object.keys(record).filter(
    (key) =>
      ![
        "$schema",
        "additionalProperties",
        "description",
        "items",
        "properties",
        "required",
        "title",
        "type",
      ].includes(key),
  );
}

function providerSlashCommandMetadataIndicatesAgent(
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (!metadata) {
    return false;
  }

  const source = normalizedMetadataText(metadata.source);
  if (
    source === "agent" ||
    source === "subagent" ||
    source === "sub-agent" ||
    source === "custom-agent" ||
    source === "selected-agent" ||
    source === "selected-subagent" ||
    source === "remote-agent" ||
    source === "hosted-agent" ||
    source === "cloud-agent" ||
    source === "background-agent" ||
    source === "web-agent" ||
    source === "a2a-agent" ||
    source === "agent-card" ||
    source === "side-chat" ||
    source === "side-conversation"
  ) {
    return true;
  }

  const mode = normalizedMetadataText(metadata.mode ?? metadata.agentMode ?? metadata.agent_mode);
  if (mode === "agent" || mode === "subagent" || mode === "sub-agent") {
    return true;
  }

  const kind = normalizedMetadataText(metadata.kind ?? metadata.agentKind ?? metadata.agent_kind);
  if (
    kind === "agent" ||
    kind === "subagent" ||
    kind === "sub-agent" ||
    kind === "remote" ||
    kind === "hosted" ||
    kind === "cloud" ||
    kind === "a2a"
  ) {
    return true;
  }

  const directAgents = providerCommandMetadataStringList(
    metadata.agent ?? metadata.agentName ?? metadata.agent_name,
  );
  if (directAgents.length > 0) {
    return true;
  }

  const directMetadata = providerAgentMetadataFromRecord(metadata);
  if (directMetadata.id || directMetadata.name || directMetadata.type || directMetadata.prompt) {
    return true;
  }

  const nestedAgentRecord = providerAgentRecord(metadata);
  if (!nestedAgentRecord) {
    return false;
  }
  const nestedMetadata = providerAgentMetadataFromRecord(nestedAgentRecord);
  return Boolean(
    nestedMetadata.id || nestedMetadata.name || nestedMetadata.type || nestedMetadata.prompt,
  );
}

export function normalizeProviderSlashCommandName(value: string): string | null {
  const name = value.trim().replace(/^[/@$]+/, "");
  if (!name || /\s/.test(name)) {
    return null;
  }
  return name;
}

export function isProviderSideConversationAlias(value: string): boolean {
  const name = normalizeProviderSlashCommandName(value)?.replace(/^\.+/, "").toLowerCase();
  return name === "side" || name === "btw";
}

export function isAceSideConversationCommand(value: string): boolean {
  return value.trim().toLowerCase() === "/side";
}

export function providerSlashCommandExtensionKind(
  command: ProviderSlashCommand,
  normalizedName: string,
): ProviderExtensionCommandKind | null {
  const declaredKind = normalizeProviderCommandKind(command.kind);
  if (declaredKind) {
    return declaredKind;
  }

  if (providerSlashCommandMetadataIndicatesAgent(command.metadata)) {
    return "agent";
  }
  if (command.kind === "provider") {
    return null;
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
      const kind =
        normalizedKind === "provider"
          ? inferredExtensionKind
          : (normalizedKind ?? inferredExtensionKind);
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
      if (isProviderSideConversationAlias(name)) {
        continue;
      }
      const normalizedKind = normalizeProviderSlashCommandKind(candidate.kind);
      const inferredExtensionKind = providerSlashCommandExtensionKind(candidate, name);
      const kind =
        normalizedKind === "provider"
          ? (inferredExtensionKind ?? "provider")
          : (normalizedKind ?? inferredExtensionKind ?? undefined);
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
        ...(candidate.metadata ? { metadata: candidate.metadata } : {}),
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
