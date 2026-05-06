import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type {
  ProviderKind,
  ProviderSlashCommand,
  ServerProvider,
  ServerSettings,
} from "@ace/contracts";
import {
  mergeProviderSlashCommands,
  providerPluginSlashCommand,
  providerSkillSlashCommand,
} from "@ace/shared/providerSlashCommands";

type CommandInput = {
  readonly cwd?: string | undefined;
  readonly codexHome?: string | undefined;
  readonly agentsHome?: string | undefined;
};

type ProviderExtensionInput = {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
  readonly agentsHome?: string | undefined;
};

type ProviderCommandInput = {
  readonly provider: ProviderKind;
  readonly cwd?: string | undefined;
  readonly settings: ServerSettings;
};

type PluginManifest = {
  readonly name?: string;
  readonly description?: string;
  readonly skills?: string;
  readonly commands?: string;
  readonly interface?: {
    readonly displayName?: string;
    readonly shortDescription?: string;
    readonly longDescription?: string;
  };
};

type ClaudeInstalledPlugins = {
  readonly plugins?: Record<
    string,
    ReadonlyArray<{
      readonly installPath?: string;
      readonly version?: string;
    }>
  >;
};

type ClaudeInstalledPluginEntry = {
  readonly name: string;
  readonly installPath: string;
};

type SkillReadOptions = {
  readonly prefix?: string | undefined;
  readonly promptPrefix?: (commandName: string, skillName: string) => string;
};

const COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,120}$/u;

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir).toSorted((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function safeReadFile(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function isDirectory(value: string): boolean {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function normalizeCommandName(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, "-");
  return COMMAND_NAME_PATTERN.test(normalized) ? normalized : null;
}

function frontmatterField(markdown: string, field: string): string | undefined {
  const frontmatter = /^---\n(?<body>[\s\S]*?)\n---/u.exec(markdown)?.groups?.body;
  if (!frontmatter) {
    return undefined;
  }
  const match = new RegExp(`^${field}:\\s*(?<value>.+)$`, "mu").exec(frontmatter);
  const value = match?.groups?.value?.trim();
  if (!value) {
    return undefined;
  }
  return value.replace(/^["']|["']$/g, "").trim() || undefined;
}

function readSkillCommand(
  skillDir: string,
  options: SkillReadOptions = {},
): ProviderSlashCommand | null {
  const skillFile = path.join(skillDir, "SKILL.md");
  const markdown = safeReadFile(skillFile);
  if (!markdown) {
    return null;
  }
  const rawName = frontmatterField(markdown, "name") ?? path.basename(skillDir);
  const skillName = normalizeCommandName(rawName);
  if (!skillName) {
    return null;
  }
  const commandName = options.prefix ? `${options.prefix}:${skillName}` : skillName;
  const description = frontmatterField(markdown, "description") ?? `Use ${commandName}`;
  return providerSkillSlashCommand({
    name: commandName,
    description,
    promptPrefix: options.promptPrefix?.(commandName, skillName) ?? `$${commandName}`,
    inputHint: "<prompt>",
  });
}

function readSkillRoot(
  root: string,
  options: SkillReadOptions = {},
  depth = 0,
): ProviderSlashCommand[] {
  if (!isDirectory(root)) {
    return [];
  }
  const commands: ProviderSlashCommand[] = [];
  for (const entry of safeReadDir(root)) {
    const entryPath = path.join(root, entry);
    const command = readSkillCommand(entryPath, options);
    if (command) {
      commands.push(command);
    } else if (depth === 0 && isDirectory(entryPath)) {
      commands.push(...readSkillRoot(entryPath, options, depth + 1));
    }
  }
  return commands;
}

function safeParsePluginManifest(file: string): PluginManifest | null {
  const raw = safeReadFile(file);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as PluginManifest;
  } catch {
    return null;
  }
}

function pluginManifestFiles(root: string, manifestDirName: string): string[] {
  if (!isDirectory(root)) {
    return [];
  }
  const manifests: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 5) {
      return;
    }
    const manifestPath = path.join(dir, manifestDirName, "plugin.json");
    if (existsSync(manifestPath)) {
      manifests.push(manifestPath);
      return;
    }
    for (const entry of safeReadDir(dir)) {
      const child = path.join(dir, entry);
      if (isDirectory(child)) {
        visit(child, depth + 1);
      }
    }
  };
  visit(root, 0);
  return manifests;
}

function firstMarkdownHeading(markdown: string): string | undefined {
  const heading = /^#\s+(?<value>.+)$/mu.exec(markdown)?.groups?.value?.trim();
  return heading || undefined;
}

function readPluginMarkdownCommand(input: {
  readonly file: string;
  readonly pluginName: string;
}): ProviderSlashCommand | null {
  if (!input.file.endsWith(".md")) {
    return null;
  }
  const rawName = path.basename(input.file, ".md");
  if (rawName.startsWith("_")) {
    return null;
  }
  const commandName = normalizeCommandName(rawName);
  if (!commandName) {
    return null;
  }
  const markdown = safeReadFile(input.file);
  if (!markdown) {
    return null;
  }
  const name = `${input.pluginName}:${commandName}`;
  return providerPluginSlashCommand({
    name,
    description: frontmatterField(markdown, "description") ?? firstMarkdownHeading(markdown),
    promptPrefix: `/${name}`,
    inputHint: "<prompt>",
  });
}

function readPluginMarkdownCommandRoot(input: {
  readonly root: string;
  readonly pluginName: string;
}): ProviderSlashCommand[] {
  if (!isDirectory(input.root)) {
    return [];
  }
  return safeReadDir(input.root)
    .map((entry) =>
      readPluginMarkdownCommand({
        file: path.join(input.root, entry),
        pluginName: input.pluginName,
      }),
    )
    .filter((command): command is ProviderSlashCommand => command !== null);
}

function naturalPluginPromptPrefix(pluginName: string): string {
  return `Use the ${pluginName} plugin.`;
}

function naturalSkillPromptPrefix(commandName: string, skillName: string): string {
  const pluginName = commandName.includes(":") ? commandName.split(":", 1)[0] : undefined;
  return pluginName
    ? `Use the ${skillName} skill from the ${pluginName} plugin:`
    : `Use the ${skillName} skill:`;
}

function readPluginCommands(input: {
  readonly pluginJsonPath: string;
  readonly manifestDirName: string;
  readonly includeMarkdownCommands?: boolean | undefined;
  readonly pluginPromptPrefix?: (pluginName: string) => string;
  readonly skillPromptPrefix?: (commandName: string, skillName: string) => string;
}): ProviderSlashCommand[] {
  const manifest = safeParsePluginManifest(input.pluginJsonPath);
  const pluginRoot = path.dirname(path.dirname(input.pluginJsonPath));
  const pluginName = normalizeCommandName(manifest?.name ?? path.basename(pluginRoot));
  if (!manifest || !pluginName) {
    return [];
  }
  return readPluginRootCommands({
    manifest,
    pluginRoot,
    pluginName,
    ...(input.includeMarkdownCommands !== undefined
      ? { includeMarkdownCommands: input.includeMarkdownCommands }
      : {}),
    ...(input.pluginPromptPrefix ? { pluginPromptPrefix: input.pluginPromptPrefix } : {}),
    ...(input.skillPromptPrefix ? { skillPromptPrefix: input.skillPromptPrefix } : {}),
  });
}

function readPluginRootCommands(input: {
  readonly manifest: PluginManifest | null;
  readonly pluginRoot: string;
  readonly pluginName: string;
  readonly includeMarkdownCommands?: boolean | undefined;
  readonly pluginPromptPrefix?: (pluginName: string) => string;
  readonly skillPromptPrefix?: (commandName: string, skillName: string) => string;
}): ProviderSlashCommand[] {
  const pluginName = normalizeCommandName(input.pluginName);
  if (!pluginName) {
    return [];
  }
  const description =
    input.manifest?.interface?.shortDescription ??
    input.manifest?.interface?.longDescription ??
    input.manifest?.description ??
    `Use ${pluginName}`;
  const commands: ProviderSlashCommand[] = [
    providerPluginSlashCommand({
      name: pluginName,
      description,
      promptPrefix: input.pluginPromptPrefix?.(pluginName) ?? `@${pluginName}`,
      inputHint: "<prompt>",
    }),
  ];
  if (input.manifest?.skills) {
    commands.push(
      ...readSkillRoot(path.resolve(input.pluginRoot, input.manifest.skills), {
        prefix: pluginName,
        ...(input.skillPromptPrefix ? { promptPrefix: input.skillPromptPrefix } : {}),
      }),
    );
  }
  if (input.includeMarkdownCommands && input.manifest?.commands) {
    commands.push(
      ...readPluginMarkdownCommandRoot({
        root: path.resolve(input.pluginRoot, input.manifest.commands),
        pluginName,
      }),
    );
  }
  return commands;
}

export function discoverCodexExtensionSlashCommands(
  input: CommandInput,
): ReadonlyArray<ProviderSlashCommand> {
  const codexHome = input.codexHome?.trim() || path.join(homedir(), ".codex");
  const userAgentsHome = input.agentsHome?.trim() || path.join(homedir(), ".agents");
  const skillRoots = [
    input.cwd ? path.join(input.cwd, ".codex", "skills") : null,
    input.cwd ? path.join(input.cwd, ".agents", "skills") : null,
    path.join(codexHome, "skills"),
    path.join(userAgentsHome, "skills"),
  ].filter((root): root is string => Boolean(root));

  const skillCommands = skillRoots.flatMap((root) => readSkillRoot(root));
  const pluginCommands = pluginManifestFiles(
    path.join(codexHome, "plugins", "cache"),
    ".codex-plugin",
  ).flatMap((pluginJsonPath) =>
    readPluginCommands({
      pluginJsonPath,
      manifestDirName: ".codex-plugin",
    }),
  );

  return mergeProviderSlashCommands(skillCommands, pluginCommands);
}

function discoverSkillRootSlashCommands(input: {
  readonly roots: ReadonlyArray<string | null | undefined>;
  readonly skillPromptPrefix?: (commandName: string, skillName: string) => string;
}): ReadonlyArray<ProviderSlashCommand> {
  return mergeProviderSlashCommands(
    input.roots
      .filter((root): root is string => Boolean(root))
      .flatMap((root) =>
        readSkillRoot(root, {
          ...(input.skillPromptPrefix ? { promptPrefix: input.skillPromptPrefix } : {}),
        }),
      ),
  );
}

function readClaudeInstalledPluginEntries(claudeHome: string): ClaudeInstalledPluginEntry[] {
  const raw = safeReadFile(path.join(claudeHome, "plugins", "installed_plugins.json"));
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as ClaudeInstalledPlugins;
    return Object.entries(parsed.plugins ?? {}).flatMap(([identity, installs]) => {
      const [rawName] = identity.split("@", 1);
      const pluginName = normalizeCommandName(rawName ?? "");
      if (!pluginName) {
        return [];
      }
      return installs
        .map((entry) => entry.installPath?.trim())
        .filter((installPath): installPath is string => Boolean(installPath))
        .map((installPath) => ({ name: pluginName, installPath }));
    });
  } catch {
    return [];
  }
}

function readClaudeInstalledPluginCommands(
  entry: ClaudeInstalledPluginEntry,
): ProviderSlashCommand[] {
  const pluginRoot = entry.installPath;
  const manifestPath = path.join(entry.installPath, ".claude-plugin", "plugin.json");
  const manifest = safeParsePluginManifest(manifestPath);
  const pluginName = normalizeCommandName(manifest?.name ?? entry.name);
  if (!pluginName) {
    return [];
  }
  return readPluginRootCommands({
    manifest,
    pluginRoot,
    pluginName,
    includeMarkdownCommands: true,
    pluginPromptPrefix: naturalPluginPromptPrefix,
    skillPromptPrefix: naturalSkillPromptPrefix,
  });
}

export function discoverClaudeExtensionSlashCommands(
  input: ProviderExtensionInput,
): ReadonlyArray<ProviderSlashCommand> {
  const claudeHome = input.home?.trim() || path.join(homedir(), ".claude");
  const userAgentsHome = input.agentsHome?.trim() || path.join(homedir(), ".agents");
  const skillCommands = discoverSkillRootSlashCommands({
    roots: [
      input.cwd ? path.join(input.cwd, ".claude", "skills") : null,
      input.cwd ? path.join(input.cwd, ".agents", "skills") : null,
      path.join(claudeHome, "skills"),
      path.join(userAgentsHome, "skills"),
    ],
    skillPromptPrefix: naturalSkillPromptPrefix,
  });
  const pluginCommands = readClaudeInstalledPluginEntries(claudeHome).flatMap(
    readClaudeInstalledPluginCommands,
  );

  return mergeProviderSlashCommands(skillCommands, pluginCommands);
}

export function discoverGenericProviderExtensionSlashCommands(input: {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
  readonly agentsHome?: string | undefined;
  readonly providerHomeDirName: string;
  readonly configHomePath?: string | undefined;
  readonly pluginManifestDirName?: string | undefined;
}): ReadonlyArray<ProviderSlashCommand> {
  const providerHome =
    input.home?.trim() ||
    input.configHomePath?.trim() ||
    path.join(homedir(), input.providerHomeDirName);
  const userAgentsHome = input.agentsHome?.trim() || path.join(homedir(), ".agents");
  const skillCommands = discoverSkillRootSlashCommands({
    roots: [
      input.cwd ? path.join(input.cwd, input.providerHomeDirName, "skills") : null,
      input.cwd ? path.join(input.cwd, ".agents", "skills") : null,
      path.join(providerHome, "skills"),
      path.join(userAgentsHome, "skills"),
    ],
    skillPromptPrefix: naturalSkillPromptPrefix,
  });
  const pluginCommands = input.pluginManifestDirName
    ? pluginManifestFiles(path.join(providerHome, "plugins"), input.pluginManifestDirName).flatMap(
        (pluginJsonPath) =>
          readPluginCommands({
            pluginJsonPath,
            manifestDirName: input.pluginManifestDirName!,
            includeMarkdownCommands: true,
            pluginPromptPrefix: naturalPluginPromptPrefix,
            skillPromptPrefix: naturalSkillPromptPrefix,
          }),
      )
    : [];

  return mergeProviderSlashCommands(skillCommands, pluginCommands);
}

export function discoverProviderExtensionSlashCommands(
  input: ProviderCommandInput,
): ReadonlyArray<ProviderSlashCommand> {
  switch (input.provider) {
    case "codex":
      return discoverCodexExtensionSlashCommands({
        cwd: input.cwd,
        codexHome: input.settings.providers.codex.homePath,
      });
    case "claudeAgent":
      return discoverClaudeExtensionSlashCommands({
        cwd: input.cwd,
      });
    case "cursor":
      return discoverGenericProviderExtensionSlashCommands({
        cwd: input.cwd,
        providerHomeDirName: ".cursor",
        pluginManifestDirName: ".cursor-plugin",
      });
    case "gemini":
      return discoverGenericProviderExtensionSlashCommands({
        cwd: input.cwd,
        providerHomeDirName: ".gemini",
        pluginManifestDirName: ".gemini-plugin",
      });
    case "pi":
      return discoverGenericProviderExtensionSlashCommands({
        cwd: input.cwd,
        providerHomeDirName: ".pi",
        pluginManifestDirName: ".pi-plugin",
      });
    case "githubCopilot":
      return discoverGenericProviderExtensionSlashCommands({
        cwd: input.cwd,
        providerHomeDirName: ".github-copilot",
      });
    case "opencode":
      return discoverGenericProviderExtensionSlashCommands({
        cwd: input.cwd,
        providerHomeDirName: ".opencode",
        configHomePath: path.join(homedir(), ".config", "opencode"),
        pluginManifestDirName: ".opencode-plugin",
      });
  }
}

export function withProviderExtensionSlashCommands(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly cwd: string;
  readonly settings: ServerSettings;
}): ReadonlyArray<ServerProvider> {
  return input.providers.map((provider) => {
    const extensionCommands = discoverProviderExtensionSlashCommands({
      provider: provider.provider,
      cwd: input.cwd,
      settings: input.settings,
    });
    const commands = mergeProviderSlashCommands(extensionCommands, provider.commands);

    if (commands.length === 0) {
      if (!provider.commands) {
        return provider;
      }
      const { commands: _commands, ...providerWithoutCommands } = provider;
      return providerWithoutCommands;
    }

    return {
      ...provider,
      commands,
    };
  });
}
