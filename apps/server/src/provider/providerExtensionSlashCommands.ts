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
  providerAgentSlashCommand,
  providerPluginSlashCommand,
  providerSkillSlashCommand,
} from "@ace/shared/providerSlashCommands";

import { CODEX_GOAL_SLASH_COMMAND, isCodexGoalsFeatureEnabled } from "./codexGoalFeature.ts";

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
  readonly resolveCodexGoalsFeatureEnabled?: typeof isCodexGoalsFeatureEnabled;
};

type PluginManifest = {
  readonly name?: string;
  readonly description?: string;
  readonly agents?: string;
  readonly skills?: string;
  readonly commands?: string;
  readonly interface?: {
    readonly displayName?: string;
    readonly shortDescription?: string;
    readonly longDescription?: string;
  };
};

type GeminiExtensionManifest = {
  readonly name?: string;
  readonly description?: string;
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
  readonly commandName?: (skillName: string) => string;
  readonly requireDescription?: boolean | undefined;
};

type AgentReadOptions = {
  readonly nameFromFrontmatter?: boolean | undefined;
  readonly includeMode?: ReadonlySet<string> | undefined;
  readonly includeMissingMode?: boolean | undefined;
  readonly promptPrefix?: ((agentName: string) => string) | undefined;
  readonly normalizeFileName?: ((fileName: string) => string) | undefined;
};

export type GitHubCopilotCustomAgent = {
  readonly name: string;
  readonly prompt: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly tools?: string[] | null;
  readonly infer?: boolean;
  readonly skills?: string[];
};

export const GEMINI_BUILT_IN_SUBAGENT_COMMANDS = [
  providerAgentSlashCommand({
    name: "codebase_investigator",
    description: "Analyze codebase structure, dependencies, and implementation details.",
    promptPrefix: "@codebase_investigator",
    inputHint: "<prompt>",
  }),
  providerAgentSlashCommand({
    name: "cli_help",
    description: "Answer questions about Gemini CLI commands, configuration, and docs.",
    promptPrefix: "@cli_help",
    inputHint: "<prompt>",
  }),
  providerAgentSlashCommand({
    name: "generalist",
    description: "Run a broad multi-step task in an isolated Gemini subagent context.",
    promptPrefix: "@generalist",
    inputHint: "<prompt>",
  }),
] as const satisfies ReadonlyArray<ProviderSlashCommand>;

export const OPENCODE_BUILT_IN_SUBAGENT_COMMANDS = [
  providerAgentSlashCommand({
    name: "general",
    description: "Run a general-purpose OpenCode subagent for complex multi-step work.",
    promptPrefix: "@general",
    inputHint: "<prompt>",
  }),
  providerAgentSlashCommand({
    name: "explore",
    description: "Run a read-only OpenCode subagent for fast codebase exploration.",
    promptPrefix: "@explore",
    inputHint: "<prompt>",
  }),
  providerAgentSlashCommand({
    name: "scout",
    description: "Run an OpenCode subagent for external docs and dependency research.",
    promptPrefix: "@scout",
    inputHint: "<prompt>",
  }),
] as const satisfies ReadonlyArray<ProviderSlashCommand>;

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

function stripMarkdownAgentSuffix(fileName: string): string {
  return fileName.endsWith(".agent") ? fileName.slice(0, -".agent".length) : fileName;
}

function uniquePaths(paths: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const candidate of paths) {
    const normalized = candidate?.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function ancestorDirsUntilGitRoot(cwd: string | undefined): string[] {
  const start = cwd?.trim();
  if (!start) {
    return [];
  }
  const dirs: string[] = [];
  let current = path.resolve(start);
  while (true) {
    dirs.push(current);
    if (existsSync(path.join(current, ".git"))) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return dirs;
}

function githubCopilotHomeRoots(home?: string | undefined): string[] {
  const configuredHome = home?.trim();
  if (configuredHome) {
    return [configuredHome];
  }
  return uniquePaths([path.join(homedir(), ".copilot"), path.join(homedir(), ".github-copilot")]);
}

function githubCopilotAgentRoots(input: {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
}): string[] {
  const homeRoots = githubCopilotHomeRoots(input.home);
  return uniquePaths([
    input.cwd ? path.join(input.cwd, ".github", "agents") : null,
    ...homeRoots.flatMap((homeRoot) => [
      path.join(homeRoot, "agents"),
      path.join(homeRoot, ".github-private", "agents"),
    ]),
  ]);
}

function frontmatterField(markdown: string, field: string): string | undefined {
  const frontmatter = /^---\n(?<body>[\s\S]*?)\n---/u.exec(markdown)?.groups?.body;
  if (!frontmatter) {
    return undefined;
  }
  const match = new RegExp(`^${field}:[ \\t]*(?<value>.+)$`, "mu").exec(frontmatter);
  const value = match?.groups?.value?.trim();
  if (!value) {
    return undefined;
  }
  return value.replace(/^["']|["']$/g, "").trim() || undefined;
}

function frontmatterBooleanField(markdown: string, field: string): boolean | undefined {
  const value = frontmatterField(markdown, field)?.toLowerCase();
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return undefined;
}

function splitFrontmatterListValue(value: string): string[] {
  const trimmed = value.trim();
  const bracketed = /^\[(?<items>.*)\]$/u.exec(trimmed)?.groups?.items;
  const source = bracketed ?? trimmed;
  return source
    .split(",")
    .map((item) =>
      item
        .trim()
        .replace(/^["']|["']$/g, "")
        .trim(),
    )
    .filter((item) => item.length > 0);
}

function frontmatterStringListField(markdown: string, field: string): string[] | undefined {
  const frontmatter = /^---\n(?<body>[\s\S]*?)\n---/u.exec(markdown)?.groups?.body;
  if (!frontmatter) {
    return undefined;
  }
  const inline = new RegExp(`^${field}:[ \\t]*(?<value>.+)$`, "mu").exec(frontmatter)?.groups
    ?.value;
  if (inline) {
    const values = splitFrontmatterListValue(inline);
    return values.length > 0 ? values : undefined;
  }

  const lines = frontmatter.split(/\r?\n/u);
  const values: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!new RegExp(`^${field}:[ \\t]*$`, "u").test(lines[index] ?? "")) {
      continue;
    }
    for (let childIndex = index + 1; childIndex < lines.length; childIndex += 1) {
      const line = lines[childIndex] ?? "";
      if (/^\S/u.test(line)) {
        break;
      }
      const item = /^\s*-\s*(?<value>.+)$/u.exec(line)?.groups?.value;
      if (!item) {
        continue;
      }
      values.push(...splitFrontmatterListValue(item));
    }
    break;
  }
  return values.length > 0 ? values : undefined;
}

function markdownBodyWithoutFrontmatter(markdown: string): string {
  const match = /^---\n[\s\S]*?\n---\n?(?<body>[\s\S]*)$/u.exec(markdown);
  return (match?.groups?.body ?? markdown).trim();
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
  const commandName =
    options.commandName?.(skillName) ??
    (options.prefix ? `${options.prefix}:${skillName}` : skillName);
  const description = frontmatterField(markdown, "description");
  if (options.requireDescription && !description) {
    return null;
  }
  return providerSkillSlashCommand({
    name: commandName,
    description: description ?? `Use ${commandName}`,
    promptPrefix: options.promptPrefix?.(commandName, skillName) ?? `$${commandName}`,
    inputHint: "<prompt>",
  });
}

function readMarkdownSkillCommand(
  file: string,
  options: SkillReadOptions = {},
): ProviderSlashCommand | null {
  if (!file.endsWith(".md")) {
    return null;
  }
  const markdown = safeReadFile(file);
  if (!markdown) {
    return null;
  }
  const rawName = frontmatterField(markdown, "name") ?? path.basename(file, ".md");
  const skillName = normalizeCommandName(rawName);
  if (!skillName) {
    return null;
  }
  const commandName =
    options.commandName?.(skillName) ??
    (options.prefix ? `${options.prefix}:${skillName}` : skillName);
  const frontmatterDescription = frontmatterField(markdown, "description");
  const description = options.requireDescription
    ? frontmatterDescription
    : (frontmatterDescription ?? firstMarkdownHeading(markdown));
  if (options.requireDescription && !description) {
    return null;
  }
  return providerSkillSlashCommand({
    name: commandName,
    description: description ?? `Use ${commandName}`,
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

function readPiSkillRoot(input: {
  readonly root: string;
  readonly includeRootMarkdownFiles?: boolean | undefined;
}): ProviderSlashCommand[] {
  if (!isDirectory(input.root)) {
    return [];
  }
  const commands: ProviderSlashCommand[] = [];
  const options: SkillReadOptions = {
    commandName: (skillName) => `skill:${skillName}`,
    promptPrefix: (commandName) => `/${commandName}`,
    requireDescription: true,
  };
  for (const entry of safeReadDir(input.root)) {
    const entryPath = path.join(input.root, entry);
    const directoryCommand = readSkillCommand(entryPath, options);
    if (directoryCommand) {
      commands.push(directoryCommand);
      continue;
    }
    if (input.includeRootMarkdownFiles) {
      const fileCommand = readMarkdownSkillCommand(entryPath, options);
      if (fileCommand) {
        commands.push(fileCommand);
        continue;
      }
    }
    if (isDirectory(entryPath)) {
      commands.push(...readSkillRoot(entryPath, options, 1));
    }
  }
  return commands;
}

function readAgentMarkdownCommand(
  file: string,
  options: AgentReadOptions = {},
): ProviderSlashCommand | null {
  if (!file.endsWith(".md")) {
    return null;
  }
  const markdown = safeReadFile(file);
  if (!markdown) {
    return null;
  }
  const mode = frontmatterField(markdown, "mode")?.toLowerCase();
  if (
    options.includeMode &&
    ((!mode && !options.includeMissingMode) || (mode && !options.includeMode.has(mode)))
  ) {
    return null;
  }
  if (frontmatterBooleanField(markdown, "hidden") === true) {
    return null;
  }
  const rawName =
    (options.nameFromFrontmatter ? frontmatterField(markdown, "name") : undefined) ??
    options.normalizeFileName?.(path.basename(file, ".md")) ??
    path.basename(file, ".md");
  const agentName = normalizeCommandName(rawName);
  if (!agentName) {
    return null;
  }
  return providerAgentSlashCommand({
    name: agentName,
    description: frontmatterField(markdown, "description") ?? firstMarkdownHeading(markdown),
    promptPrefix: options.promptPrefix?.(agentName) ?? `@${agentName}`,
    inputHint: "<prompt>",
  });
}

function readAgentMarkdownRoot(
  root: string,
  options: AgentReadOptions = {},
  depth = 0,
): ProviderSlashCommand[] {
  if (!isDirectory(root)) {
    return [];
  }
  const commands: ProviderSlashCommand[] = [];
  for (const entry of safeReadDir(root)) {
    const entryPath = path.join(root, entry);
    const command = readAgentMarkdownCommand(entryPath, options);
    if (command) {
      commands.push(command);
    } else if (depth < 4 && isDirectory(entryPath)) {
      commands.push(...readAgentMarkdownRoot(entryPath, options, depth + 1));
    }
  }
  return commands;
}

function readOpenCodeJsonAgentCommands(file: string): ProviderSlashCommand[] {
  const raw = safeReadFile(file);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { readonly agent?: unknown };
    const agents =
      parsed.agent && typeof parsed.agent === "object"
        ? (parsed.agent as Record<string, unknown>)
        : {};
    return Object.entries(agents).flatMap(([rawName, rawAgent]) => {
      const agentName = normalizeCommandName(rawName);
      if (!agentName || !rawAgent || typeof rawAgent !== "object") {
        return [];
      }
      const agent = rawAgent as {
        readonly description?: unknown;
        readonly mode?: unknown;
        readonly disable?: unknown;
        readonly hidden?: unknown;
      };
      const mode = typeof agent.mode === "string" ? agent.mode.toLowerCase() : "all";
      if (
        agent.disable === true ||
        agent.hidden === true ||
        (mode !== "subagent" && mode !== "all")
      ) {
        return [];
      }
      return [
        providerAgentSlashCommand({
          name: agentName,
          description: typeof agent.description === "string" ? agent.description : undefined,
          promptPrefix: `@${agentName}`,
          inputHint: "<prompt>",
        }),
      ];
    });
  } catch {
    return [];
  }
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

function safeParseGeminiExtensionManifest(file: string): GeminiExtensionManifest | null {
  const raw = safeReadFile(file);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as GeminiExtensionManifest;
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

function readCursorMarkdownCommand(file: string): ProviderSlashCommand | null {
  if (!file.endsWith(".md")) {
    return null;
  }
  const commandName = normalizeCommandName(path.basename(file, ".md"));
  if (!commandName) {
    return null;
  }
  const markdown = safeReadFile(file);
  if (!markdown) {
    return null;
  }
  const body = markdownBodyWithoutFrontmatter(markdown);
  if (!body) {
    return null;
  }
  return providerPluginSlashCommand({
    name: commandName,
    description: frontmatterField(markdown, "description") ?? firstMarkdownHeading(markdown),
    promptPrefix: body,
    inputHint: "<prompt>",
  });
}

function readCursorMarkdownCommandRoot(root: string): ProviderSlashCommand[] {
  if (!isDirectory(root)) {
    return [];
  }
  return safeReadDir(root)
    .map((entry) => readCursorMarkdownCommand(path.join(root, entry)))
    .filter((command): command is ProviderSlashCommand => command !== null);
}

function geminiCommandNameFromTomlPath(root: string, file: string): string | null {
  if (!file.endsWith(".toml")) {
    return null;
  }
  const relative = path.relative(root, file);
  if (relative.startsWith("..")) {
    return null;
  }
  const withoutExtension = relative.slice(0, -".toml".length);
  const commandName = withoutExtension.split(path.sep).join(":");
  return normalizeCommandName(commandName);
}

function frontmatterTomlStringField(toml: string, field: string): string | undefined {
  const match = new RegExp(
    `^${field}\\s*=\\s*(?<quote>["'])(?<value>.*?)\\k<quote>\\s*$`,
    "mu",
  ).exec(toml);
  const value = match?.groups?.value?.trim();
  return value || undefined;
}

function readGeminiExtensionTomlCommand(input: {
  readonly root: string;
  readonly file: string;
}): ProviderSlashCommand | null {
  const commandName = geminiCommandNameFromTomlPath(input.root, input.file);
  if (!commandName) {
    return null;
  }
  const toml = safeReadFile(input.file);
  if (!toml) {
    return null;
  }
  return providerPluginSlashCommand({
    name: commandName,
    description: frontmatterTomlStringField(toml, "description"),
    promptPrefix: `/${commandName}`,
    inputHint: "<prompt>",
  });
}

function readGeminiExtensionTomlCommandRoot(
  commandRoot: string,
  currentRoot = commandRoot,
  depth = 0,
): ProviderSlashCommand[] {
  if (!isDirectory(currentRoot) || depth > 4) {
    return [];
  }
  const commands: ProviderSlashCommand[] = [];
  for (const entry of safeReadDir(currentRoot)) {
    const entryPath = path.join(currentRoot, entry);
    const command = readGeminiExtensionTomlCommand({ root: commandRoot, file: entryPath });
    if (command) {
      commands.push(command);
    } else if (isDirectory(entryPath)) {
      commands.push(...readGeminiExtensionTomlCommandRoot(commandRoot, entryPath, depth + 1));
    }
  }
  return commands;
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
  readonly agentPromptPrefix?: (pluginName: string, agentName: string) => string;
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
    ...(input.agentPromptPrefix ? { agentPromptPrefix: input.agentPromptPrefix } : {}),
  });
}

function readPluginRootCommands(input: {
  readonly manifest: PluginManifest | null;
  readonly pluginRoot: string;
  readonly pluginName: string;
  readonly includeMarkdownCommands?: boolean | undefined;
  readonly pluginPromptPrefix?: (pluginName: string) => string;
  readonly skillPromptPrefix?: (commandName: string, skillName: string) => string;
  readonly agentPromptPrefix?: (pluginName: string, agentName: string) => string;
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
  if (input.manifest?.agents) {
    const agentCommands = readAgentMarkdownRoot(
      path.resolve(input.pluginRoot, input.manifest.agents),
      {
        nameFromFrontmatter: true,
        promptPrefix: (agentName) =>
          input.agentPromptPrefix?.(pluginName, agentName) ?? `@${pluginName}:${agentName}`,
      },
    );
    for (const command of agentCommands) {
      commands.push(Object.assign({}, command, { name: `${pluginName}:${command.name}` }));
    }
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
        readSkillRoot(
          root,
          input.skillPromptPrefix ? { promptPrefix: input.skillPromptPrefix } : {},
        ),
      ),
  );
}

function readGeminiExtensionCommands(extensionRoot: string): ReadonlyArray<ProviderSlashCommand> {
  const manifest = safeParseGeminiExtensionManifest(
    path.join(extensionRoot, "gemini-extension.json"),
  );
  const extensionName = normalizeCommandName(manifest?.name ?? path.basename(extensionRoot));
  if (!manifest || !extensionName) {
    return [];
  }

  return mergeProviderSlashCommands(
    readAgentMarkdownRoot(path.join(extensionRoot, "agents"), {
      nameFromFrontmatter: true,
      promptPrefix: (agentName) => `@${agentName}`,
    }),
    readSkillRoot(path.join(extensionRoot, "skills"), {
      promptPrefix: naturalSkillPromptPrefix,
    }),
    readGeminiExtensionTomlCommandRoot(path.join(extensionRoot, "commands")),
  );
}

export function discoverGeminiExtensionSlashCommands(
  input: {
    readonly home?: string | undefined;
  } = {},
): ReadonlyArray<ProviderSlashCommand> {
  const geminiHome = input.home?.trim() || path.join(homedir(), ".gemini");
  const extensionsRoot = path.join(geminiHome, "extensions");
  if (!isDirectory(extensionsRoot)) {
    return [];
  }
  return mergeProviderSlashCommands(
    safeReadDir(extensionsRoot).flatMap((entry) =>
      readGeminiExtensionCommands(path.join(extensionsRoot, entry)),
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
    agentPromptPrefix: (pluginName, agentName) =>
      `Use the ${agentName} subagent from ${pluginName}:`,
  });
}

export function discoverClaudeExtensionSlashCommands(
  input: ProviderExtensionInput,
): ReadonlyArray<ProviderSlashCommand> {
  const claudeHome = input.home?.trim() || path.join(homedir(), ".claude");
  const userAgentsHome = input.agentsHome?.trim() || path.join(homedir(), ".agents");
  const agentCommands = mergeProviderSlashCommands(
    [input.cwd ? path.join(input.cwd, ".claude", "agents") : null, path.join(claudeHome, "agents")]
      .filter((root): root is string => Boolean(root))
      .flatMap((root) =>
        readAgentMarkdownRoot(root, {
          nameFromFrontmatter: true,
          promptPrefix: (agentName) => `Use the ${agentName} subagent:`,
        }),
      ),
  );
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

  return mergeProviderSlashCommands(agentCommands, skillCommands, pluginCommands);
}

function discoverProviderAgentSlashCommands(input: {
  readonly cwd?: string | undefined;
  readonly providerHome: string;
  readonly providerHomeDirName: string;
  readonly nameFromFrontmatter?: boolean | undefined;
  readonly includeMode?: ReadonlySet<string> | undefined;
  readonly includeMissingMode?: boolean | undefined;
  readonly promptPrefix?: (agentName: string) => string;
}): ReadonlyArray<ProviderSlashCommand> {
  return mergeProviderSlashCommands(
    [
      input.cwd ? path.join(input.cwd, input.providerHomeDirName, "agents") : null,
      path.join(input.providerHome, "agents"),
    ]
      .filter((root): root is string => Boolean(root))
      .flatMap((root) =>
        readAgentMarkdownRoot(root, {
          nameFromFrontmatter: input.nameFromFrontmatter,
          includeMode: input.includeMode,
          includeMissingMode: input.includeMissingMode,
          promptPrefix: input.promptPrefix,
        }),
      ),
  );
}

export function discoverGenericProviderExtensionSlashCommands(input: {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
  readonly agentsHome?: string | undefined;
  readonly providerHomeDirName: string;
  readonly configHomePath?: string | undefined;
  readonly pluginManifestDirName?: string | undefined;
  readonly includeAgentCommands?: boolean | undefined;
  readonly includeSkillCommands?: boolean | undefined;
}): ReadonlyArray<ProviderSlashCommand> {
  const providerHome =
    input.home?.trim() ||
    input.configHomePath?.trim() ||
    path.join(homedir(), input.providerHomeDirName);
  const userAgentsHome = input.agentsHome?.trim() || path.join(homedir(), ".agents");
  const agentCommands =
    input.includeAgentCommands === false
      ? []
      : discoverProviderAgentSlashCommands({
          cwd: input.cwd,
          providerHome,
          providerHomeDirName: input.providerHomeDirName,
          nameFromFrontmatter: true,
        });
  const skillCommands = discoverSkillRootSlashCommands({
    roots:
      input.includeSkillCommands === false
        ? []
        : [
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

  return mergeProviderSlashCommands(agentCommands, skillCommands, pluginCommands);
}

export function discoverCursorExtensionSlashCommands(input: {
  readonly cwd?: string | undefined;
  readonly configDir?: string | undefined;
  readonly agentsHome?: string | undefined;
}): ReadonlyArray<ProviderSlashCommand> {
  const cursorHome = input.configDir?.trim() || path.join(homedir(), ".cursor");
  return mergeProviderSlashCommands(
    readCursorMarkdownCommandRoot(input.cwd ? path.join(input.cwd, ".cursor", "commands") : ""),
    readCursorMarkdownCommandRoot(path.join(cursorHome, "commands")),
    discoverGenericProviderExtensionSlashCommands({
      cwd: input.cwd,
      home: cursorHome,
      agentsHome: input.agentsHome,
      providerHomeDirName: ".cursor",
      pluginManifestDirName: ".cursor-plugin",
    }),
  );
}

export function discoverGitHubCopilotAgentSlashCommands(input: {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
}): ReadonlyArray<ProviderSlashCommand> {
  const roots = githubCopilotAgentRoots(input);

  return mergeProviderSlashCommands(
    roots.flatMap((root) =>
      readAgentMarkdownRoot(root, {
        nameFromFrontmatter: true,
        normalizeFileName: stripMarkdownAgentSuffix,
      }),
    ),
  );
}

function readGitHubCopilotCustomAgent(file: string): GitHubCopilotCustomAgent | null {
  if (!file.endsWith(".md")) {
    return null;
  }
  const markdown = safeReadFile(file);
  if (!markdown) {
    return null;
  }
  const name = normalizeCommandName(stripMarkdownAgentSuffix(path.basename(file, ".md")));
  const prompt = markdownBodyWithoutFrontmatter(markdown);
  if (!name || !prompt) {
    return null;
  }
  const displayName = frontmatterField(markdown, "name");
  const description = frontmatterField(markdown, "description");
  const tools = frontmatterStringListField(markdown, "tools");
  const infer = frontmatterBooleanField(markdown, "infer");
  const skills = frontmatterStringListField(markdown, "skills");
  return {
    name,
    prompt,
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    ...(tools ? { tools } : {}),
    ...(infer !== undefined ? { infer } : {}),
    ...(skills ? { skills } : {}),
  };
}

function readGitHubCopilotCustomAgentRoot(root: string, depth = 0): GitHubCopilotCustomAgent[] {
  if (!isDirectory(root)) {
    return [];
  }
  const agents: GitHubCopilotCustomAgent[] = [];
  for (const entry of safeReadDir(root)) {
    const entryPath = path.join(root, entry);
    const agent = readGitHubCopilotCustomAgent(entryPath);
    if (agent) {
      agents.push(agent);
    } else if (depth < 4 && isDirectory(entryPath)) {
      agents.push(...readGitHubCopilotCustomAgentRoot(entryPath, depth + 1));
    }
  }
  return agents;
}

export function discoverGitHubCopilotCustomAgents(input: {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
}): ReadonlyArray<GitHubCopilotCustomAgent> {
  const roots = githubCopilotAgentRoots(input);
  const agents: GitHubCopilotCustomAgent[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const agent of readGitHubCopilotCustomAgentRoot(root)) {
      const key = agent.name.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      agents.push(agent);
    }
  }
  return agents;
}

export function discoverGitHubCopilotSkillDirectories(input: {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
  readonly agentsHome?: string | undefined;
}): ReadonlyArray<string> {
  const providerHomes = githubCopilotHomeRoots(input.home);
  const userAgentsHome = input.agentsHome?.trim() || path.join(homedir(), ".agents");
  return uniquePaths([
    input.cwd ? path.join(input.cwd, ".github", "skills") : null,
    input.cwd ? path.join(input.cwd, ".github-copilot", "skills") : null,
    input.cwd ? path.join(input.cwd, ".agents", "skills") : null,
    ...providerHomes.map((providerHome) => path.join(providerHome, "skills")),
    path.join(userAgentsHome, "skills"),
  ]).filter((root) => isDirectory(root));
}

export function discoverOpenCodeAgentSlashCommands(input: {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
}): ReadonlyArray<ProviderSlashCommand> {
  const providerHome = input.home?.trim() || path.join(homedir(), ".config", "opencode");
  return mergeProviderSlashCommands(
    discoverProviderAgentSlashCommands({
      cwd: input.cwd,
      providerHome,
      providerHomeDirName: ".opencode",
      includeMode: new Set(["subagent", "all"]),
      includeMissingMode: true,
    }),
    [
      input.cwd ? path.join(input.cwd, "opencode.json") : null,
      path.join(providerHome, "opencode.json"),
    ]
      .filter((file): file is string => Boolean(file))
      .flatMap(readOpenCodeJsonAgentCommands),
  );
}

export function discoverPiExtensionSlashCommands(input: {
  readonly cwd?: string | undefined;
  readonly agentDir?: string | undefined;
  readonly agentsHome?: string | undefined;
}): ReadonlyArray<ProviderSlashCommand> {
  const piAgentDir = input.agentDir?.trim() || path.join(homedir(), ".pi", "agent");
  const userAgentsHome = input.agentsHome?.trim() || path.join(homedir(), ".agents");
  const ancestorDirs = ancestorDirsUntilGitRoot(input.cwd);
  const piSpecificRoots = uniquePaths([
    ...ancestorDirs.map((dir) => path.join(dir, ".pi", "skills")),
    path.join(piAgentDir, "skills"),
  ]);
  const sharedAgentRoots = uniquePaths([
    ...ancestorDirs.map((dir) => path.join(dir, ".agents", "skills")),
    path.join(userAgentsHome, "skills"),
  ]);

  return mergeProviderSlashCommands(
    piSpecificRoots.flatMap((root) =>
      readPiSkillRoot({
        root,
        includeRootMarkdownFiles: true,
      }),
    ),
    sharedAgentRoots.flatMap((root) =>
      readPiSkillRoot({
        root,
      }),
    ),
    discoverGenericProviderExtensionSlashCommands({
      cwd: input.cwd,
      home: piAgentDir,
      providerHomeDirName: ".pi",
      pluginManifestDirName: ".pi-plugin",
      includeSkillCommands: false,
    }),
  );
}

export function discoverProviderExtensionSlashCommands(
  input: ProviderCommandInput,
): ReadonlyArray<ProviderSlashCommand> {
  switch (input.provider) {
    case "codex":
      return mergeProviderSlashCommands(
        discoverCodexExtensionSlashCommands({
          cwd: input.cwd,
          codexHome: input.settings.providers.codex.homePath,
        }),
        [CODEX_GOAL_SLASH_COMMAND],
      );
    case "claudeAgent":
      return discoverClaudeExtensionSlashCommands({
        cwd: input.cwd,
      });
    case "cursor":
      return discoverCursorExtensionSlashCommands({
        cwd: input.cwd,
        configDir: input.settings.providers.cursor.configDir,
      });
    case "gemini":
      return mergeProviderSlashCommands(
        discoverGenericProviderExtensionSlashCommands({
          cwd: input.cwd,
          providerHomeDirName: ".gemini",
        }),
        discoverGeminiExtensionSlashCommands(),
        GEMINI_BUILT_IN_SUBAGENT_COMMANDS,
      );
    case "pi":
      return discoverPiExtensionSlashCommands({
        cwd: input.cwd,
        agentDir: input.settings.providers.pi.agentDir,
      });
    case "githubCopilot":
      return mergeProviderSlashCommands(
        discoverGitHubCopilotAgentSlashCommands({
          cwd: input.cwd,
          home: input.settings.providers.githubCopilot.homePath,
        }),
        discoverSkillRootSlashCommands({
          roots: discoverGitHubCopilotSkillDirectories({
            cwd: input.cwd,
            home: input.settings.providers.githubCopilot.homePath,
          }),
          skillPromptPrefix: naturalSkillPromptPrefix,
        }),
        discoverGenericProviderExtensionSlashCommands({
          cwd: input.cwd,
          home: input.settings.providers.githubCopilot.homePath,
          providerHomeDirName: ".github-copilot",
        }),
      );
    case "opencode":
      return mergeProviderSlashCommands(
        discoverOpenCodeAgentSlashCommands({
          cwd: input.cwd,
        }),
        OPENCODE_BUILT_IN_SUBAGENT_COMMANDS,
        discoverGenericProviderExtensionSlashCommands({
          cwd: input.cwd,
          providerHomeDirName: ".opencode",
          configHomePath: path.join(homedir(), ".config", "opencode"),
          pluginManifestDirName: ".opencode-plugin",
          includeAgentCommands: false,
        }),
      );
  }
}

export function withProviderExtensionSlashCommands(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly cwd: string;
  readonly settings: ServerSettings;
  readonly resolveCodexGoalsFeatureEnabled?: typeof isCodexGoalsFeatureEnabled;
}): ReadonlyArray<ServerProvider> {
  return input.providers.map((provider) => {
    const commandInput: ProviderCommandInput = {
      provider: provider.provider,
      cwd: input.cwd,
      settings: input.settings,
    };
    const extensionCommands = discoverProviderExtensionSlashCommands(
      input.resolveCodexGoalsFeatureEnabled
        ? {
            ...commandInput,
            resolveCodexGoalsFeatureEnabled: input.resolveCodexGoalsFeatureEnabled,
          }
        : commandInput,
    );
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
