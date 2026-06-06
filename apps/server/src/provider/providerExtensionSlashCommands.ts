import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type {
  ProviderKind,
  ProviderSessionConfigOption,
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
  readonly agents?: string | ReadonlyArray<string>;
  readonly skills?: string | ReadonlyArray<string>;
  readonly commands?: string | ReadonlyArray<string>;
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

type GeminiAgentOverride = {
  readonly enabled?: unknown;
  readonly model?: unknown;
  readonly temperature?: unknown;
  readonly tools?: unknown;
  readonly modelConfig?: unknown;
  readonly model_config?: unknown;
  readonly runConfig?: unknown;
  readonly run_config?: unknown;
};

type GeminiSettingsFile = {
  readonly experimental?: {
    readonly enableAgents?: unknown;
  };
  readonly agents?: {
    readonly overrides?: Record<string, GeminiAgentOverride>;
  };
  readonly extensions?: {
    readonly disabled?: unknown;
  };
};

type ClaudeSettingsFile = {
  readonly outputStyle?: unknown;
  readonly agent?: unknown;
  readonly permissions?: {
    readonly deny?: unknown;
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

type ClaudeOutputStyle = {
  readonly value: string;
  readonly name: string;
  readonly description?: string | undefined;
};

type PiPackageManifest = {
  readonly keywords?: unknown;
  readonly pi?: {
    readonly prompts?: unknown;
    readonly skills?: unknown;
    readonly agents?: unknown;
    readonly extensions?: unknown;
  };
};

type PiSettingsFile = {
  readonly packages?: unknown;
  readonly prompts?: unknown;
  readonly skills?: unknown;
  readonly agents?: unknown;
  readonly subagents?: unknown;
  readonly enableSkillCommands?: unknown;
};

type PiPackageSourceEntry = {
  readonly source: string;
  readonly prompts?: unknown;
  readonly skills?: unknown;
  readonly agents?: unknown;
  readonly extensions?: unknown;
};

type SkillReadOptions = {
  readonly prefix?: string | undefined;
  readonly promptPrefix?: (commandName: string, skillName: string) => string;
  readonly commandName?: (skillName: string) => string;
  readonly metadata?: (markdown: string) => Record<string, unknown> | undefined;
  readonly nameFromFrontmatter?: boolean | undefined;
  readonly requireDescription?: boolean | undefined;
};

const SKILL_MANIFEST_FILES = ["SKILL.md", "skill.md"] as const;
const USER_INVOCABLE_FRONTMATTER_FIELDS = [
  "user-invocable",
  "user-invokable",
  "userInvocable",
  "userInvokable",
  "user_invocable",
  "user_invokable",
] as const;
const DISABLE_MODEL_INVOCATION_FRONTMATTER_FIELDS = [
  "disable-model-invocation",
  "disableModelInvocation",
  "disable_model_invocation",
] as const;

type AgentReadOptions = {
  readonly nameFromFrontmatter?: boolean | undefined;
  readonly requireNameFromFrontmatter?: boolean | undefined;
  readonly includeMode?: ReadonlySet<string> | undefined;
  readonly includeMissingMode?: boolean | undefined;
  readonly excludeKind?: ReadonlySet<string> | undefined;
  readonly excludeDisabled?: boolean | undefined;
  readonly requireDescription?: boolean | undefined;
  readonly metadata?: (markdown: string) => Record<string, unknown> | undefined;
  readonly promptPrefix?: ((agentName: string) => string) | undefined;
  readonly normalizeFileName?: ((fileName: string) => string) | undefined;
  readonly transformName?: ((agentName: string, markdown: string) => string) | undefined;
};

export type GitHubCopilotCustomAgent = {
  readonly name: string;
  readonly prompt: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly argumentHint?: string;
  readonly tools?: string[] | null;
  readonly agents?: string[];
  readonly infer?: boolean;
  readonly userInvocable?: boolean;
  readonly disableModelInvocation?: boolean;
  readonly target?: string[];
  readonly model?: string | string[];
  readonly metadata?: Record<string, string>;
  readonly handoffs?: ReadonlyArray<{
    readonly label?: string;
    readonly agent?: string;
    readonly prompt?: string;
    readonly send?: boolean;
    readonly model?: string;
  }>;
  readonly mcpServers?: Record<
    string,
    | {
        readonly type?: "local" | "stdio";
        readonly command: string;
        readonly args: string[];
        readonly tools: string[];
        readonly env?: Record<string, string>;
        readonly cwd?: string;
        readonly timeout?: number;
      }
    | {
        readonly type: "http" | "sse";
        readonly url: string;
        readonly tools: string[];
        readonly headers?: Record<string, string>;
        readonly timeout?: number;
      }
  >;
  readonly skills?: string[];
  readonly hooks?: Record<string, ReadonlyArray<Record<string, unknown>>>;
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
  providerAgentSlashCommand({
    name: "browser_agent",
    description: "Run Gemini's browser automation subagent for web navigation tasks.",
    promptPrefix: "@browser_agent",
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

export const CURSOR_BUILT_IN_SUBAGENT_COMMANDS = [
  providerAgentSlashCommand({
    name: "explore",
    description: "Run Cursor's built-in codebase search subagent.",
    promptPrefix: "/explore",
    inputHint: "<prompt>",
    metadata: {
      provider: "cursor",
      source: "built-in-subagent",
    },
  }),
  providerAgentSlashCommand({
    name: "bash",
    description: "Run Cursor's built-in shell command subagent.",
    promptPrefix: "/bash",
    inputHint: "<prompt>",
    metadata: {
      provider: "cursor",
      source: "built-in-subagent",
    },
  }),
  providerAgentSlashCommand({
    name: "browser",
    description: "Run Cursor's built-in browser automation subagent.",
    promptPrefix: "/browser",
    inputHint: "<prompt>",
    metadata: {
      provider: "cursor",
      source: "built-in-subagent",
    },
  }),
] as const satisfies ReadonlyArray<ProviderSlashCommand>;

export const PI_BUILT_IN_SUBAGENT_COMMANDS = [
  providerAgentSlashCommand({
    name: "scout",
    description: "Run fast local codebase reconnaissance in a focused Pi child agent.",
    promptPrefix: "@scout",
    inputHint: "<prompt>",
  }),
  providerAgentSlashCommand({
    name: "researcher",
    description: "Research external docs and recent changes with sources in a Pi child agent.",
    promptPrefix: "@researcher",
    inputHint: "<prompt>",
  }),
  providerAgentSlashCommand({
    name: "planner",
    description: "Turn current context into a concrete implementation plan without editing.",
    promptPrefix: "@planner",
    inputHint: "<prompt>",
  }),
  providerAgentSlashCommand({
    name: "worker",
    description: "Implement an approved plan in a focused Pi child agent.",
    promptPrefix: "@worker",
    inputHint: "<prompt>",
  }),
  providerAgentSlashCommand({
    name: "reviewer",
    description: "Review code, tests, edge cases, and simplicity in a Pi child agent.",
    promptPrefix: "@reviewer",
    inputHint: "<prompt>",
  }),
  providerAgentSlashCommand({
    name: "debugger",
    description: "Investigate failures and regressions systematically in a Pi child agent.",
    promptPrefix: "@debugger",
    inputHint: "<prompt>",
  }),
  providerAgentSlashCommand({
    name: "verifier",
    description: "Run checks and report concrete verification evidence in a Pi child agent.",
    promptPrefix: "@verifier",
    inputHint: "<prompt>",
  }),
  providerAgentSlashCommand({
    name: "security-auditor",
    description: "Review trust boundaries and unsafe behavior in a Pi child agent.",
    promptPrefix: "@security-auditor",
    inputHint: "<prompt>",
  }),
  providerAgentSlashCommand({
    name: "docs-writer",
    description: "Draft documentation updates grounded in code and existing docs.",
    promptPrefix: "@docs-writer",
    inputHint: "<prompt>",
  }),
  providerAgentSlashCommand({
    name: "refactorer",
    description: "Perform behavior-preserving cleanup and simplification in a Pi child agent.",
    promptPrefix: "@refactorer",
    inputHint: "<prompt>",
  }),
  providerAgentSlashCommand({
    name: "context-builder",
    description: "Gather stronger planning context and handoff material in a Pi child agent.",
    promptPrefix: "@context-builder",
    inputHint: "<prompt>",
  }),
  providerAgentSlashCommand({
    name: "oracle",
    description: "Get an advisory second opinion before acting, without editing files.",
    promptPrefix: "@oracle",
    inputHint: "<prompt>",
  }),
  providerAgentSlashCommand({
    name: "delegate",
    description: "Run a lightweight general Pi child agent close to the parent session behavior.",
    promptPrefix: "@delegate",
    inputHint: "<prompt>",
  }),
] as const satisfies ReadonlyArray<ProviderSlashCommand>;

export const CLAUDE_BUILT_IN_SUBAGENT_COMMANDS = [
  providerAgentSlashCommand({
    name: "explore",
    description: "Use Claude's read-only Explore subagent for fast codebase research.",
    promptPrefix: "@agent-explore",
    inputHint: "<prompt>",
  }),
  providerAgentSlashCommand({
    name: "plan",
    description: "Use Claude's Plan subagent for planning-oriented codebase research.",
    promptPrefix: "@agent-plan",
    inputHint: "<prompt>",
  }),
  providerAgentSlashCommand({
    name: "general-purpose",
    description: "Use Claude's general-purpose subagent for complex multi-step tasks.",
    promptPrefix: "@agent-general-purpose",
    inputHint: "<prompt>",
  }),
] as const satisfies ReadonlyArray<ProviderSlashCommand>;

export const GITHUB_COPILOT_BUILT_IN_AGENT_COMMANDS = [
  providerAgentSlashCommand({
    name: "explore",
    description: "Explore the codebase and gather implementation context with GitHub Copilot.",
    promptPrefix: "@explore",
    inputHint: "<prompt>",
  }),
  providerAgentSlashCommand({
    name: "task",
    description: "Delegate a focused implementation task to GitHub Copilot.",
    promptPrefix: "@task",
    inputHint: "<prompt>",
  }),
  providerAgentSlashCommand({
    name: "general-purpose",
    description: "Delegate broad multi-step work to GitHub Copilot general-purpose agent.",
    promptPrefix: "@general-purpose",
    inputHint: "<prompt>",
  }),
  providerAgentSlashCommand({
    name: "code-review",
    description: "Run GitHub Copilot code-review agent on a change or code area.",
    promptPrefix: "@code-review",
    inputHint: "<prompt>",
  }),
  providerAgentSlashCommand({
    name: "research",
    description: "Run GitHub Copilot's research agent for deep codebase and API research.",
    promptPrefix: "@research",
    inputHint: "<prompt>",
  }),
  providerAgentSlashCommand({
    name: "rubber-duck",
    description: "Ask GitHub Copilot's rubber-duck agent for a second opinion on plans or changes.",
    promptPrefix: "@rubber-duck",
    inputHint: "<prompt>",
  }),
  providerAgentSlashCommand({
    name: "fleet",
    description: "Split work across GitHub Copilot's parallel subagent fleet.",
    promptPrefix: "/fleet",
    inputHint: "<prompt>",
  }),
] as const satisfies ReadonlyArray<ProviderSlashCommand>;

const COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,120}$/u;
const GITHUB_COPILOT_CUSTOM_AGENT_PROMPT_MAX_LENGTH = 30_000;

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

function firstReadableSkillManifest(skillDir: string): string | null {
  for (const fileName of SKILL_MANIFEST_FILES) {
    const markdown = safeReadFile(path.join(skillDir, fileName));
    if (markdown) {
      return markdown;
    }
  }
  return null;
}

function isDirectory(value: string): boolean {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function isRegularFile(value: string): boolean {
  try {
    return statSync(value).isFile();
  } catch {
    return false;
  }
}

function normalizeCommandName(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, "-");
  return COMMAND_NAME_PATTERN.test(normalized) ? normalized : null;
}

function stripGitHubCopilotAgentSuffix(fileName: string): string {
  if (fileName.endsWith(".chatmode")) {
    return fileName.slice(0, -".chatmode".length);
  }
  if (fileName.endsWith(".agents")) {
    return fileName.slice(0, -".agents".length);
  }
  if (fileName.endsWith(".agent")) {
    return fileName.slice(0, -".agent".length);
  }
  return fileName;
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

function githubCopilotPluginRoots(home?: string | undefined): string[] {
  return uniquePaths(
    githubCopilotHomeRoots(home).flatMap((homeRoot) => [
      path.join(homeRoot, "installed-plugins"),
      path.join(homeRoot, "plugins"),
    ]),
  );
}

function githubCopilotWorkspaceSettings(cwd: string | undefined): Record<string, unknown> | null {
  const start = cwd?.trim();
  if (!start) {
    return null;
  }
  for (const dir of ancestorDirsUntilGitRoot(path.resolve(start))) {
    const settings = safeParseJsoncRecord(path.join(dir, ".vscode", "settings.json"));
    if (settings) {
      return settings;
    }
  }
  return null;
}

function githubCopilotProjectRoots(cwd: string | undefined): string[] {
  const start = cwd?.trim();
  if (!start) {
    return [];
  }
  const root = path.resolve(start);
  const settings = githubCopilotWorkspaceSettings(root);
  return settings?.["chat.useCustomizationsInParentRepositories"] === true
    ? ancestorDirsUntilGitRoot(root)
    : [root];
}

function githubCopilotPrivateRepositoryAgentRoots(root: string): string[] {
  return path.basename(root) === ".github-private" ? [path.join(root, "agents")] : [];
}

function githubCopilotAgentSkillsEnabled(cwd: string | undefined): boolean {
  return githubCopilotWorkspaceSettings(cwd)?.["chat.useAgentSkills"] !== false;
}

function githubCopilotCustomAgentHooksEnabled(cwd: string | undefined): boolean {
  return githubCopilotWorkspaceSettings(cwd)?.["chat.useCustomAgentHooks"] === true;
}

function githubCopilotAgentRoots(input: {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
  readonly includeChatModes?: boolean | undefined;
}): string[] {
  const homeRoots = githubCopilotHomeRoots(input.home);
  const projectRoots = githubCopilotProjectRoots(input.cwd);
  const userAgentRoots = homeRoots.flatMap((homeRoot) => [
    path.join(homeRoot, "agents"),
    ...(input.includeChatModes === false ? [] : [path.join(homeRoot, "chatmodes")]),
  ]);
  const projectAgentRoots = projectRoots.flatMap((root) => [
    path.join(root, ".github", "agents"),
    ...(input.includeChatModes === false ? [] : [path.join(root, ".github", "chatmodes")]),
    path.join(root, ".claude", "agents"),
    ...githubCopilotConfiguredAgentRoots(root),
  ]);
  const organizationAgentRoots = [
    ...projectRoots.flatMap((root) => githubCopilotPrivateRepositoryAgentRoots(root)),
    ...homeRoots.map((homeRoot) => path.join(homeRoot, ".github-private", "agents")),
  ];
  return uniquePaths([...projectAgentRoots, ...organizationAgentRoots, ...userAgentRoots]);
}

function githubCopilotPromptRoots(input: {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
}): string[] {
  const homeRoots = githubCopilotHomeRoots(input.home);
  const projectRoots = githubCopilotProjectRoots(input.cwd);
  return uniquePaths([
    ...projectRoots.map((root) => path.join(root, ".github", "prompts")),
    ...projectRoots.flatMap((root) => githubCopilotConfiguredPromptRoots(root)),
    ...homeRoots.map((homeRoot) => path.join(homeRoot, "prompts")),
  ]);
}

function githubCopilotConfiguredPromptRoots(projectRoot: string): string[] {
  const settings = safeParseJsoncRecord(path.join(projectRoot, ".vscode", "settings.json"));
  const value = settings?.["chat.promptFilesLocations"] ?? settings?.["chat.promptFiles"];
  return resolveWorkspaceLocationSetting(projectRoot, value);
}

function githubCopilotConfiguredAgentRoots(projectRoot: string): string[] {
  const settings = safeParseJsoncRecord(path.join(projectRoot, ".vscode", "settings.json"));
  const value = settings?.["chat.agentFilesLocations"] ?? settings?.["chat.agentFiles"];
  return resolveWorkspaceLocationSetting(projectRoot, value);
}

function githubCopilotConfiguredInstructionRoots(projectRoot: string): string[] {
  const settings = safeParseJsoncRecord(path.join(projectRoot, ".vscode", "settings.json"));
  const value =
    settings?.["chat.instructionsFilesLocations"] ?? settings?.["chat.instructionsFiles"];
  return resolveWorkspaceLocationSetting(projectRoot, value);
}

function githubCopilotConfiguredSkillRoots(projectRoot: string): string[] {
  const settings = safeParseJsoncRecord(path.join(projectRoot, ".vscode", "settings.json"));
  const value = settings?.["chat.agentSkillsLocations"] ?? settings?.["chat.skillsFiles"];
  return resolveWorkspaceLocationSetting(projectRoot, value);
}

function workspaceLocationSettingEntries(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim().length > 0 ? [value.trim()] : [];
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.entries(value as Record<string, unknown>)
    .filter(([, enabled]) => enabled !== false)
    .map(([location]) => location.trim())
    .filter((location) => location.length > 0);
}

function resolveWorkspaceLocationSetting(baseDir: string, value: unknown): string[] {
  return workspaceLocationSettingEntries(value).flatMap((rawLocation) => {
    if (rawLocation.startsWith("!") || rawLocation.startsWith("-")) {
      return [];
    }
    const exactLocation = rawLocation.startsWith("+") ? rawLocation.slice(1).trim() : rawLocation;
    if (!exactLocation) {
      return [];
    }
    const hasGlob = /[*?[\]{}]/u.test(exactLocation);
    const withoutGlob = exactLocation.split(/[*?[\]{}]/u, 1)[0]?.replace(/[\\/]+$/u, "") ?? "";
    const resolvedLocation = withoutGlob || (hasGlob ? "." : exactLocation);
    if (resolvedLocation.startsWith("~/")) {
      return [path.join(homedir(), resolvedLocation.slice(2))];
    }
    if (path.isAbsolute(resolvedLocation)) {
      return [resolvedLocation];
    }
    return [path.resolve(baseDir, resolvedLocation)];
  });
}

function githubCopilotInstructionFiles(input: {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
}): string[] {
  const homeRoots = githubCopilotHomeRoots(input.home);
  const projectRoots = githubCopilotProjectRoots(input.cwd);
  return uniquePaths([
    ...projectRoots.flatMap((root) => [
      path.join(root, "AGENTS.md"),
      path.join(root, "CLAUDE.md"),
      path.join(root, "CLAUDE.local.md"),
      path.join(root, "GEMINI.md"),
      path.join(root, ".github", "copilot-instructions.md"),
      path.join(root, ".claude", "CLAUDE.md"),
      path.join(root, ".claude", "CLAUDE.local.md"),
    ]),
    ...homeRoots.map((homeRoot) => path.join(homeRoot, "copilot-instructions.md")),
    ...homeRoots.flatMap((homeRoot) => [
      path.join(homeRoot, "CLAUDE.md"),
      path.join(homeRoot, "GEMINI.md"),
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

function frontmatterBlockScalarField(markdown: string, field: string): string | undefined {
  const frontmatter = /^---\n(?<body>[\s\S]*?)\n---/u.exec(markdown)?.groups?.body;
  if (!frontmatter) {
    return undefined;
  }
  const lines = frontmatter.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (!new RegExp(`^${field}:[ \\t]*[|>]\\s*$`, "u").test(lines[index] ?? "")) {
      continue;
    }
    const block: string[] = [];
    for (let childIndex = index + 1; childIndex < lines.length; childIndex += 1) {
      const line = lines[childIndex] ?? "";
      if (/^\S/u.test(line)) {
        break;
      }
      block.push(line);
    }
    const nonEmptyLines = block.filter((line) => line.trim().length > 0);
    const commonIndent =
      nonEmptyLines.length > 0
        ? Math.min(...nonEmptyLines.map((line) => leadingSpaceCount(line)))
        : 0;
    const value = block
      .map((line) => line.slice(Math.min(commonIndent, line.length)))
      .join("\n")
      .trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
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

function frontmatterBooleanFieldAny(
  markdown: string,
  fields: ReadonlyArray<string>,
): boolean | undefined {
  for (const field of fields) {
    const value = frontmatterBooleanField(markdown, field);
    if (value !== undefined) {
      return value;
    }
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
    if (/^\[\s*\]$/u.test(inline.trim())) {
      return [];
    }
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

function frontmatterStringOrListField(
  markdown: string,
  field: string,
): string | string[] | undefined {
  const values = frontmatterStringListField(markdown, field);
  if (values === undefined) {
    return undefined;
  }
  return values.length === 1 ? values[0] : values;
}

function frontmatterArgumentNames(markdown: string): string[] | undefined {
  const values = frontmatterStringListField(markdown, "arguments");
  if (!values || values.length === 0) {
    return undefined;
  }
  const normalized = values.flatMap((value) =>
    value
      .split(/\s+/u)
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );
  return normalized.length > 0 ? normalized : undefined;
}

function frontmatterArgumentHint(markdown: string): string {
  const explicit = frontmatterField(markdown, "argument-hint");
  if (explicit) {
    return explicit;
  }
  const argumentsList = frontmatterArgumentNames(markdown);
  if (argumentsList && argumentsList.length > 0) {
    return argumentsList.map((argument) => `[${argument}]`).join(" ");
  }
  return "<prompt>";
}

function claudeCommandMetadata(
  markdown: string,
  source: "command" | "skill",
): Record<string, unknown> | undefined {
  const argumentsList = frontmatterArgumentNames(markdown);
  const allowedTools = frontmatterStringOrListField(markdown, "allowed-tools");
  const model = frontmatterField(markdown, "model");
  const disableModelInvocation = frontmatterBooleanFieldAny(
    markdown,
    DISABLE_MODEL_INVOCATION_FRONTMATTER_FIELDS,
  );
  const context = frontmatterField(markdown, "context");
  const agent = frontmatterField(markdown, "agent");
  const hooks =
    frontmatterJsonObjectField(markdown, "hooks") ?? frontmatterYamlObjectField(markdown, "hooks");
  const metadata = {
    provider: "claude",
    source,
    ...(argumentsList ? { arguments: argumentsList } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(model ? { model } : {}),
    ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}),
    ...(context ? { context } : {}),
    ...(agent ? { agent } : {}),
    ...(hooks ? { hooks } : {}),
  };
  return Object.keys(metadata).length > 2 ? metadata : undefined;
}

function claudeAgentMetadata(markdown: string): Record<string, unknown> | undefined {
  const tools = frontmatterStringOrListField(markdown, "tools");
  const allowedTools = frontmatterStringOrListField(markdown, "allowed-tools");
  const disallowedTools =
    frontmatterStringOrListField(markdown, "disallowedTools") ??
    frontmatterStringOrListField(markdown, "disallowed-tools");
  const model = frontmatterField(markdown, "model");
  const permissionMode =
    frontmatterField(markdown, "permissionMode") ?? frontmatterField(markdown, "permission-mode");
  const mcpServers =
    frontmatterJsonObjectField(markdown, "mcpServers") ??
    frontmatterJsonObjectField(markdown, "mcp-servers") ??
    frontmatterYamlObjectField(markdown, "mcpServers") ??
    frontmatterYamlObjectField(markdown, "mcp-servers");
  const hooks =
    frontmatterJsonObjectField(markdown, "hooks") ?? frontmatterYamlObjectField(markdown, "hooks");
  const maxTurns =
    frontmatterNumberField(markdown, "maxTurns") ?? frontmatterNumberField(markdown, "max-turns");
  const skills = frontmatterStringOrListField(markdown, "skills");
  const initialPrompt =
    frontmatterField(markdown, "initialPrompt") ?? frontmatterField(markdown, "initial-prompt");
  const effort = frontmatterField(markdown, "effort");
  const background = frontmatterBooleanField(markdown, "background");
  const isolation = frontmatterField(markdown, "isolation");
  const color = frontmatterField(markdown, "color");
  const memory =
    frontmatterJsonObjectField(markdown, "memory") ??
    frontmatterYamlObjectField(markdown, "memory");
  const metadata = {
    provider: "claude",
    source: "agent",
    ...(tools !== undefined ? { tools } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    ...(model ? { model } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(hooks ? { hooks } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(initialPrompt ? { initialPrompt } : {}),
    ...(effort ? { effort } : {}),
    ...(background !== undefined ? { background } : {}),
    ...(isolation ? { isolation } : {}),
    ...(color ? { color } : {}),
    ...(memory ? { memory } : {}),
  };
  return Object.keys(metadata).length > 2 ? metadata : undefined;
}

function frontmatterNumberField(markdown: string, field: string): number | undefined {
  const raw = frontmatterField(markdown, field);
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function frontmatterFieldAny(markdown: string, fields: ReadonlyArray<string>): string | undefined {
  for (const field of fields) {
    const value = frontmatterField(markdown, field);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function frontmatterNumberFieldAny(
  markdown: string,
  fields: ReadonlyArray<string>,
): number | undefined {
  for (const field of fields) {
    const value = frontmatterNumberField(markdown, field);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function frontmatterBlockScalarFieldAny(
  markdown: string,
  fields: ReadonlyArray<string>,
): string | undefined {
  for (const field of fields) {
    const value = frontmatterBlockScalarField(markdown, field);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function geminiAgentMetadata(markdown: string, source: "agent" | "remote-agent") {
  const kind = frontmatterField(markdown, "kind");
  const tools = frontmatterStringOrListField(markdown, "tools");
  const model = frontmatterField(markdown, "model");
  const temperature = frontmatterNumberField(markdown, "temperature");
  const maxTurns = frontmatterNumberFieldAny(markdown, ["max_turns", "maxTurns", "max-turns"]);
  const timeoutMins = frontmatterNumberFieldAny(markdown, [
    "timeout_mins",
    "timeoutMins",
    "timeout-mins",
  ]);
  const mcpServers =
    frontmatterJsonObjectField(markdown, "mcpServers") ??
    frontmatterJsonObjectField(markdown, "mcp_servers") ??
    frontmatterJsonObjectField(markdown, "mcp-servers") ??
    frontmatterYamlObjectField(markdown, "mcpServers") ??
    frontmatterYamlObjectField(markdown, "mcp_servers") ??
    frontmatterYamlObjectField(markdown, "mcp-servers");
  const metadata = {
    provider: "gemini",
    source,
    ...(kind ? { kind } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(model ? { model } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(timeoutMins !== undefined ? { timeoutMins } : {}),
    ...(mcpServers ? { mcpServers } : {}),
  };
  return Object.keys(metadata).length > 2 ? metadata : undefined;
}

function cursorAgentMetadata(markdown: string): Record<string, unknown> | undefined {
  const model = frontmatterField(markdown, "model");
  const readOnly = frontmatterBooleanField(markdown, "read_only");
  const isBackground = frontmatterBooleanField(markdown, "is_background");
  const metadata = {
    provider: "cursor",
    source: "agent",
    ...(model ? { model } : {}),
    ...(readOnly !== undefined ? { readOnly } : {}),
    ...(isBackground !== undefined ? { isBackground } : {}),
  };
  return Object.keys(metadata).length > 2 ? metadata : undefined;
}

function frontmatterBlock(markdown: string, field: string): string | undefined {
  const frontmatter = /^---\n(?<body>[\s\S]*?)\n---/u.exec(markdown)?.groups?.body;
  if (!frontmatter) {
    return undefined;
  }
  const lines = frontmatter.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (!new RegExp(`^${field}:[ \\t]*$`, "u").test(lines[index] ?? "")) {
      continue;
    }
    const block: string[] = [];
    for (let childIndex = index + 1; childIndex < lines.length; childIndex += 1) {
      const line = lines[childIndex] ?? "";
      if (/^\S/u.test(line)) {
        break;
      }
      block.push(line);
    }
    return block.join("\n");
  }
  return undefined;
}

function parseSimpleYamlScalar(value: string): string {
  return value
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
}

function frontmatterContent(markdown: string): string | undefined {
  return /^---\n(?<body>[\s\S]*?)\n---/u.exec(markdown)?.groups?.body;
}

function parseSimpleYamlBoolean(value: string): boolean | undefined {
  const normalized = parseSimpleYamlScalar(value).toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return undefined;
}

function parseSimpleYamlValue(value: string): unknown {
  const trimmed = value.trim();
  if (/^\[(?<items>.*)\]$/u.test(trimmed)) {
    return splitFrontmatterListValue(trimmed);
  }
  const booleanValue = parseSimpleYamlBoolean(trimmed);
  if (booleanValue !== undefined) {
    return booleanValue;
  }
  if (/^-?\d+(?:\.\d+)?$/u.test(trimmed)) {
    return Number(trimmed);
  }
  return parseSimpleYamlScalar(trimmed);
}

function parseSimpleYamlKey(value: string): string {
  return parseSimpleYamlScalar(value);
}

function leadingSpaceCount(value: string): number {
  return /^\s*/u.exec(value)?.[0].length ?? 0;
}

function setYamlObjectValue(
  root: Record<string, unknown>,
  pathSegments: ReadonlyArray<string>,
  value: unknown,
): void {
  let target = root;
  for (let index = 0; index < pathSegments.length - 1; index += 1) {
    const segment = pathSegments[index];
    if (!segment) {
      continue;
    }
    const existing = target[segment];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      const child: Record<string, unknown> = {};
      target[segment] = child;
      target = child;
      continue;
    }
    target = existing as Record<string, unknown>;
  }
  const last = pathSegments.at(-1);
  if (last) {
    target[last] = value;
  }
}

function getYamlObjectValue(
  root: Record<string, unknown>,
  pathSegments: ReadonlyArray<string>,
): unknown {
  let value: unknown = root;
  for (const segment of pathSegments) {
    if (!segment || !value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function frontmatterYamlObjectField(
  markdown: string,
  field: string,
): Record<string, unknown> | undefined {
  const block = frontmatterBlock(markdown, field);
  if (!block) {
    return undefined;
  }
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; key: string }> = [];
  let lastPath: string[] = [];

  for (const rawLine of block.split(/\r?\n/u)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) {
      continue;
    }
    const indent = leadingSpaceCount(rawLine);
    const line = rawLine.trim();

    while (stack.length > 0 && indent <= stack.at(-1)!.indent) {
      stack.pop();
    }

    if (line.startsWith("- ")) {
      const item = line.slice(2).trim();
      const existing = getYamlObjectValue(root, lastPath);
      const list = Array.isArray(existing) ? existing : [];
      list.push(parseSimpleYamlValue(item));
      setYamlObjectValue(root, lastPath, list);
      continue;
    }

    const match = /^(?<key>"[^"]+"|'[^']+'|[A-Za-z0-9_.*/-]+):(?:\s*(?<value>.*))?$/u.exec(line);
    if (!match?.groups?.key) {
      continue;
    }
    const key = parseSimpleYamlKey(match.groups.key);
    if (!key) {
      continue;
    }

    const value = match.groups.value?.trim();
    const pathSegments = [...stack.map((entry) => entry.key), key];
    lastPath = pathSegments;
    if (value) {
      setYamlObjectValue(root, pathSegments, parseSimpleYamlValue(value));
      continue;
    }

    setYamlObjectValue(root, pathSegments, {});
    stack.push({ indent, key });
  }

  return Object.keys(root).length > 0 ? root : undefined;
}

function frontmatterObjectListField(
  markdown: string,
  field: string,
): ReadonlyArray<Record<string, string | boolean>> | undefined {
  const block = frontmatterBlock(markdown, field);
  if (!block) {
    return undefined;
  }
  const items: Array<Record<string, string | boolean>> = [];
  let current: Record<string, string | boolean> | null = null;
  const assign = (target: Record<string, string | boolean>, rawKey: string, rawValue: string) => {
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (!key || !value) {
      return;
    }
    const booleanValue = parseSimpleYamlBoolean(value);
    target[key] = booleanValue ?? parseSimpleYamlScalar(value);
  };

  for (const line of block.split(/\r?\n/u)) {
    const itemMatch = /^\s*-\s*(?<rest>.*)$/u.exec(line);
    if (itemMatch) {
      current = {};
      items.push(current);
      const rest = itemMatch.groups?.rest?.trim();
      if (rest) {
        const fieldMatch = /^(?<key>[A-Za-z0-9_.-]+):\s*(?<value>.+)$/u.exec(rest);
        if (fieldMatch?.groups) {
          assign(current, fieldMatch.groups.key ?? "", fieldMatch.groups.value ?? "");
        }
      }
      continue;
    }
    if (!current) {
      continue;
    }
    const fieldMatch = /^\s+(?<key>[A-Za-z0-9_.-]+):\s*(?<value>.+)$/u.exec(line);
    if (fieldMatch?.groups) {
      assign(current, fieldMatch.groups.key ?? "", fieldMatch.groups.value ?? "");
    }
  }
  return items.length > 0 ? items : undefined;
}

function frontmatterRootObjectList(
  markdown: string,
): ReadonlyArray<Record<string, string | boolean>> | undefined {
  const frontmatter = frontmatterContent(markdown);
  if (!frontmatter) {
    return undefined;
  }
  if (!frontmatter.split(/\r?\n/u).some((line) => /^-\s+/u.test(line))) {
    return undefined;
  }
  const items: Array<Record<string, string | boolean>> = [];
  let current: Record<string, string | boolean> | null = null;
  const assign = (target: Record<string, string | boolean>, rawKey: string, rawValue: string) => {
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (!key || !value) {
      return;
    }
    const booleanValue = parseSimpleYamlBoolean(value);
    target[key] = booleanValue ?? parseSimpleYamlScalar(value);
  };

  for (const line of frontmatter.split(/\r?\n/u)) {
    const itemMatch = /^\s*-\s*(?<rest>.*)$/u.exec(line);
    if (itemMatch) {
      current = {};
      items.push(current);
      const rest = itemMatch.groups?.rest?.trim();
      if (rest) {
        const fieldMatch = /^(?<key>[A-Za-z0-9_.-]+):\s*(?<value>.+)$/u.exec(rest);
        if (fieldMatch?.groups) {
          assign(current, fieldMatch.groups.key ?? "", fieldMatch.groups.value ?? "");
        }
      }
      continue;
    }
    if (!current) {
      continue;
    }
    const fieldMatch = /^\s+(?<key>[A-Za-z0-9_.-]+):\s*(?<value>.+)$/u.exec(line);
    if (fieldMatch?.groups) {
      assign(current, fieldMatch.groups.key ?? "", fieldMatch.groups.value ?? "");
    }
  }
  return items.length > 0 ? items : undefined;
}

function frontmatterJsonObjectField(
  markdown: string,
  field: string,
): Record<string, unknown> | undefined {
  const raw = frontmatterField(markdown, field);
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function frontmatterJsonValueField(markdown: string, field: string): unknown {
  const raw = frontmatterField(markdown, field);
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function markdownBodyWithoutFrontmatter(markdown: string): string {
  const match = /^---\n[\s\S]*?\n---\n?(?<body>[\s\S]*)$/u.exec(markdown);
  return (match?.groups?.body ?? markdown).trim();
}

function readSkillCommand(
  skillDir: string,
  options: SkillReadOptions = {},
): ProviderSlashCommand | null {
  const markdown = firstReadableSkillManifest(skillDir);
  if (!markdown) {
    return null;
  }
  if (frontmatterBooleanFieldAny(markdown, USER_INVOCABLE_FRONTMATTER_FIELDS) === false) {
    return null;
  }
  const rawName =
    (options.nameFromFrontmatter === false ? undefined : frontmatterField(markdown, "name")) ??
    path.basename(skillDir);
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
    inputHint: frontmatterArgumentHint(markdown),
    metadata: options.metadata?.(markdown),
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
  if (frontmatterBooleanFieldAny(markdown, USER_INVOCABLE_FRONTMATTER_FIELDS) === false) {
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
    inputHint: frontmatterArgumentHint(markdown),
    metadata: options.metadata?.(markdown),
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
    } else if (depth < 4 && isDirectory(entryPath)) {
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
  for (const entry of safeReadDir(input.root)) {
    const entryPath = path.join(input.root, entry);
    const directoryCommand = readSkillCommand(entryPath, PI_SKILL_READ_OPTIONS);
    if (directoryCommand) {
      commands.push(directoryCommand);
      continue;
    }
    if (input.includeRootMarkdownFiles) {
      const fileCommand = readMarkdownSkillCommand(entryPath, PI_SKILL_READ_OPTIONS);
      if (fileCommand) {
        commands.push(fileCommand);
        continue;
      }
    }
    if (isDirectory(entryPath)) {
      commands.push(...readSkillRoot(entryPath, PI_SKILL_READ_OPTIONS, 1));
    }
  }
  return commands;
}

const PI_SKILL_READ_OPTIONS: SkillReadOptions = {
  commandName: (skillName) => `skill:${skillName}`,
  promptPrefix: (commandName) => `/${commandName}`,
  requireDescription: true,
};

function firstNonEmptyMarkdownLine(markdown: string): string | undefined {
  const body = markdownBodyWithoutFrontmatter(markdown);
  for (const line of body.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    return trimmed.replace(/^#+\s*/u, "").trim() || undefined;
  }
  return undefined;
}

function readPiPromptTemplateCommand(file: string): ProviderSlashCommand | null {
  if (!file.endsWith(".md")) {
    return null;
  }
  const rawName = path.basename(file, ".md");
  if (rawName.startsWith("_")) {
    return null;
  }
  const commandName = normalizeCommandName(rawName);
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
  const description =
    frontmatterField(markdown, "description") ?? firstNonEmptyMarkdownLine(markdown);
  return {
    name: commandName,
    kind: "provider",
    promptPrefix: `/${commandName}`,
    inputHint: frontmatterArgumentHint(markdown),
    ...(claudeCommandMetadata(markdown, "command")
      ? { metadata: claudeCommandMetadata(markdown, "command") }
      : {}),
    ...(description ? { description } : {}),
  };
}

function readPiPromptTemplateRoot(root: string): ProviderSlashCommand[] {
  if (!isDirectory(root)) {
    return [];
  }
  return safeReadDir(root)
    .map((entry) => readPiPromptTemplateCommand(path.join(root, entry)))
    .filter((command): command is ProviderSlashCommand => command !== null);
}

function safeParseJsonRecord(file: string): Record<string, unknown> | null {
  const raw = safeReadFile(file);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readGeminiSettingsFile(file: string): GeminiSettingsFile | null {
  return safeParseJsonRecord(file) as GeminiSettingsFile | null;
}

function geminiSettingsFiles(input: {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
}): string[] {
  const geminiHome = input.home?.trim() || path.join(homedir(), ".gemini");
  const projectRoots = ancestorDirsUntilGitRoot(input.cwd).toReversed();
  return uniquePaths([
    path.join(geminiHome, "settings.json"),
    ...projectRoots.map((root) => path.join(root, ".gemini", "settings.json")),
  ]);
}

export function resolveGeminiAgentSettings(input: {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
}): {
  readonly enabled: boolean;
  readonly disabledAgentNames: ReadonlySet<string>;
  readonly enabledAgentNames: ReadonlySet<string>;
  readonly agentMetadataOverrides: ReadonlyMap<string, Record<string, unknown>>;
} {
  let enabled = true;
  const disabledAgentNames = new Set<string>();
  const enabledAgentNames = new Set<string>();
  const agentMetadataOverrides = new Map<string, Record<string, unknown>>();
  for (const settingsFile of geminiSettingsFiles(input)) {
    const settings = readGeminiSettingsFile(settingsFile);
    if (!settings) {
      continue;
    }
    if (settings.experimental?.enableAgents === false) {
      enabled = false;
    }
    for (const [agentName, override] of Object.entries(settings.agents?.overrides ?? {})) {
      const normalizedName = normalizeCommandName(agentName);
      if (!normalizedName) {
        continue;
      }
      const normalizedKey = normalizedName.toLowerCase();
      if (override?.enabled === false) {
        enabledAgentNames.delete(normalizedKey);
        disabledAgentNames.add(normalizedKey);
      } else if (override?.enabled === true) {
        enabledAgentNames.add(normalizedKey);
        disabledAgentNames.delete(normalizedKey);
      }
      const metadata = geminiAgentOverrideMetadata(override);
      if (metadata) {
        agentMetadataOverrides.set(normalizedKey, {
          ...(agentMetadataOverrides.get(normalizedKey) ?? {}),
          ...metadata,
        });
      }
    }
  }
  return { enabled, disabledAgentNames, enabledAgentNames, agentMetadataOverrides };
}

function geminiBuiltInSubagentCommandsForSettings(
  settings: ReturnType<typeof resolveGeminiAgentSettings>,
): ReadonlyArray<ProviderSlashCommand> {
  if (!settings.enabled) {
    return [];
  }
  return GEMINI_BUILT_IN_SUBAGENT_COMMANDS.filter(
    (command) =>
      !settings.disabledAgentNames.has(command.name.toLowerCase()) &&
      (command.name !== "browser_agent" || settings.enabledAgentNames.has("browser_agent")),
  ).map((command) => withGeminiAgentOverrideMetadata(command, settings));
}

export function geminiBuiltInSubagentCommands(input: {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
}): ReadonlyArray<ProviderSlashCommand> {
  return geminiBuiltInSubagentCommandsForSettings(resolveGeminiAgentSettings(input));
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstStringFromUnknown(...values: ReadonlyArray<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function firstNumberFromUnknown(...values: ReadonlyArray<unknown>): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function stringOrStringArrayFromUnknown(value: unknown): string | string[] | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    const values = splitFrontmatterListValue(value);
    if (values.length === 0) {
      return undefined;
    }
    return values.length === 1 ? values[0] : values;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  if (values.length === 0) {
    return undefined;
  }
  return values.length === 1 ? values[0] : values;
}

function normalizedGeminiPathRulePath(value: string | undefined): string {
  const normalized = path.resolve(value?.trim() || process.cwd()).replaceAll(path.sep, "/");
  return normalized.startsWith("/") ? `${normalized.replace(/\/+$/u, "")}/` : `/${normalized}/`;
}

function geminiEnablementRuleMatches(rule: string, cwd: string | undefined): boolean {
  const rawRule = rule.startsWith("!") ? rule.slice(1) : rule;
  const includeSubdirs = rawRule.endsWith("*");
  const normalizedRule = normalizedGeminiPathRulePath(
    includeSubdirs ? rawRule.slice(0, -1) : rawRule,
  );
  const normalizedCwd = normalizedGeminiPathRulePath(cwd);
  return includeSubdirs
    ? normalizedCwd === normalizedRule || normalizedCwd.startsWith(normalizedRule)
    : normalizedCwd === normalizedRule;
}

function geminiDisabledExtensionNames(input: {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
}): Set<string> {
  const disabled = new Set<string>();
  for (const settingsFile of geminiSettingsFiles(input)) {
    const settings = readGeminiSettingsFile(settingsFile);
    for (const entry of stringArrayFromUnknown(settings?.extensions?.disabled)) {
      disabled.add(entry.toLowerCase());
    }
  }
  return disabled;
}

function isGeminiExtensionEnabled(input: {
  readonly extensionName: string;
  readonly cwd?: string | undefined;
  readonly geminiHome: string;
}): boolean {
  const extensionName = input.extensionName.toLowerCase();
  const disabledNames = geminiDisabledExtensionNames({
    cwd: input.cwd,
    home: input.geminiHome,
  });
  if (disabledNames.has("none") || disabledNames.has(extensionName)) {
    return false;
  }
  const enablement = safeParseJsonRecord(
    path.join(input.geminiHome, "extensions", "extension-enablement.json"),
  );
  const extensionConfig = enablement?.[input.extensionName];
  const overrides =
    extensionConfig && typeof extensionConfig === "object" && !Array.isArray(extensionConfig)
      ? stringArrayFromUnknown((extensionConfig as { readonly overrides?: unknown }).overrides)
      : [];
  let enabled = true;
  for (const override of overrides) {
    if (!geminiEnablementRuleMatches(override, input.cwd)) {
      continue;
    }
    enabled = !override.startsWith("!");
  }
  return enabled;
}

function applyGeminiAgentSettings(
  commands: ReadonlyArray<ProviderSlashCommand>,
  settings: ReturnType<typeof resolveGeminiAgentSettings>,
): ReadonlyArray<ProviderSlashCommand> {
  if (
    settings.enabled &&
    settings.disabledAgentNames.size === 0 &&
    settings.agentMetadataOverrides.size === 0
  ) {
    return commands;
  }
  return commands
    .filter((command) => {
      if (command.kind !== "agent") {
        return true;
      }
      if (!settings.enabled) {
        return false;
      }
      return !settings.disabledAgentNames.has(command.name.toLowerCase());
    })
    .map((command) =>
      command.kind === "agent" ? withGeminiAgentOverrideMetadata(command, settings) : command,
    );
}

function geminiAgentOverrideMetadata(
  override: GeminiAgentOverride | undefined,
): Record<string, unknown> | undefined {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return undefined;
  }
  const record = override as Record<string, unknown>;
  const modelConfig =
    recordFromUnknown(record.modelConfig) ?? recordFromUnknown(record.model_config);
  const runConfig = recordFromUnknown(record.runConfig) ?? recordFromUnknown(record.run_config);
  const model = firstStringFromUnknown(record.model, modelConfig?.model, modelConfig?.modelName);
  const temperature = firstNumberFromUnknown(record.temperature, modelConfig?.temperature);
  const topP = firstNumberFromUnknown(
    record.topP,
    record.top_p,
    modelConfig?.topP,
    modelConfig?.top_p,
  );
  const topK = firstNumberFromUnknown(
    record.topK,
    record.top_k,
    modelConfig?.topK,
    modelConfig?.top_k,
  );
  const maxTurns = firstNumberFromUnknown(
    record.maxTurns,
    record.max_turns,
    runConfig?.maxTurns,
    runConfig?.max_turns,
  );
  const timeoutMins = firstNumberFromUnknown(
    record.timeoutMins,
    record.timeout_mins,
    runConfig?.timeoutMins,
    runConfig?.timeout_mins,
  );
  const tools = stringOrStringArrayFromUnknown(record.tools ?? runConfig?.tools);
  const metadata = {
    ...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {}),
    ...(model ? { model } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(topK !== undefined ? { topK } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(timeoutMins !== undefined ? { timeoutMins } : {}),
    ...(tools !== undefined ? { tools } : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function withGeminiAgentOverrideMetadata(
  command: ProviderSlashCommand,
  settings: ReturnType<typeof resolveGeminiAgentSettings>,
): ProviderSlashCommand {
  const override = settings.agentMetadataOverrides.get(command.name.toLowerCase());
  if (!override) {
    return command;
  }
  return {
    ...command,
    metadata: {
      ...(command.metadata ?? {}),
      provider: "gemini",
      ...(command.metadata?.source ? {} : { source: "agent" }),
      settingsOverride: true,
      ...override,
    },
  };
}

function readClaudeSettingsFile(file: string): ClaudeSettingsFile | null {
  return safeParseJsonRecord(file) as ClaudeSettingsFile | null;
}

function claudeSettingsFiles(input: {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
}): string[] {
  const claudeHome = input.home?.trim() || path.join(homedir(), ".claude");
  const projectRoots = ancestorDirsUntilGitRoot(input.cwd);
  return uniquePaths([
    ...projectRoots.flatMap((root) => [
      path.join(root, ".claude", "settings.json"),
      path.join(root, ".claude", "settings.local.json"),
    ]),
    path.join(claudeHome, "settings.json"),
  ]);
}

function claudeDeniedAgentName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^Agent\((?<agentName>[^)]+)\)$/iu.exec(value.trim());
  const agentName = normalizeCommandName(match?.groups?.agentName ?? "");
  return agentName ? agentName.toLowerCase() : null;
}

function resolveClaudeAgentSettings(input: {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
}): {
  readonly currentAgent: string | null;
  readonly deniedAgentNames: ReadonlySet<string>;
} {
  let currentAgent: string | null = null;
  const deniedAgentNames = new Set<string>();
  for (const settingsFile of claudeSettingsFiles(input)) {
    const settings = readClaudeSettingsFile(settingsFile);
    if (!settings) {
      continue;
    }
    const agent = normalizeCommandName(typeof settings.agent === "string" ? settings.agent : "");
    if (agent) {
      currentAgent = agent;
    }
    const deny = settings.permissions?.deny;
    if (!Array.isArray(deny)) {
      continue;
    }
    for (const entry of deny) {
      const agentName = claudeDeniedAgentName(entry);
      if (agentName) {
        deniedAgentNames.add(agentName);
      }
    }
  }
  return { currentAgent, deniedAgentNames };
}

function claudeAgentCommandNames(command: ProviderSlashCommand): ReadonlyArray<string> {
  const names = new Set<string>();
  const commandName = normalizeCommandName(command.name);
  if (commandName) {
    names.add(commandName.toLowerCase());
    const suffix = commandName.split(":").at(-1);
    if (suffix) {
      names.add(suffix.toLowerCase());
    }
  }
  const promptPrefix = command.promptPrefix?.trim();
  if (promptPrefix?.startsWith("/")) {
    const promptName = normalizeCommandName(promptPrefix.slice(1).split(/\s/u, 1)[0] ?? "");
    if (promptName) {
      names.add(promptName.toLowerCase());
    }
  }
  return [...names];
}

function applyClaudeAgentSettings(
  commands: ReadonlyArray<ProviderSlashCommand>,
  settings: ReturnType<typeof resolveClaudeAgentSettings>,
): ReadonlyArray<ProviderSlashCommand> {
  if (settings.deniedAgentNames.size === 0) {
    return commands;
  }
  return commands.filter((command) => {
    if (command.kind !== "agent") {
      return true;
    }
    return !claudeAgentCommandNames(command).some((name) => settings.deniedAgentNames.has(name));
  });
}

export function discoverClaudeSdkAgentSlashCommands(input: {
  readonly agents: unknown;
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
}): ReadonlyArray<ProviderSlashCommand> {
  const entries = normalizeClaudeSdkAgentEntries(input.agents);
  if (entries.length === 0) {
    return [];
  }
  const commands = entries.flatMap((entry): ReadonlyArray<ProviderSlashCommand> => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const record = entry as {
      readonly name?: unknown;
      readonly description?: unknown;
      readonly model?: unknown;
      readonly prompt?: unknown;
      readonly tools?: unknown;
      readonly allowedTools?: unknown;
      readonly allowed_tools?: unknown;
      readonly maxTurns?: unknown;
      readonly max_turns?: unknown;
    };
    const name = normalizeCommandName(typeof record.name === "string" ? record.name : "");
    if (!name) {
      return [];
    }
    const description =
      typeof record.description === "string" && record.description.trim().length > 0
        ? record.description.trim()
        : undefined;
    const model =
      typeof record.model === "string" && record.model.trim().length > 0
        ? record.model.trim()
        : undefined;
    const tools =
      normalizeClaudeSdkStringList(record.tools) ??
      normalizeClaudeSdkStringList(record.allowedTools) ??
      normalizeClaudeSdkStringList(record.allowed_tools);
    const prompt =
      typeof record.prompt === "string" && record.prompt.trim().length > 0
        ? record.prompt.trim()
        : undefined;
    const maxTurns =
      typeof record.maxTurns === "number" && Number.isFinite(record.maxTurns)
        ? record.maxTurns
        : typeof record.max_turns === "number" && Number.isFinite(record.max_turns)
          ? record.max_turns
          : undefined;
    const metadata = {
      provider: "claude",
      source: "sdk-agent",
      ...(model ? { model } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(prompt ? { prompt } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    };
    return [
      providerAgentSlashCommand({
        name,
        ...(description
          ? { description: model ? `${description} Model: ${model}.` : description }
          : model
            ? { description: `Claude Code subagent. Model: ${model}.` }
            : {}),
        promptPrefix: `@${name}`,
        inputHint: "<prompt>",
        metadata,
      }),
    ];
  });
  return applyClaudeAgentSettings(
    mergeProviderSlashCommands(commands),
    resolveClaudeAgentSettings({
      cwd: input.cwd,
      home: input.home,
    }),
  );
}

function normalizeClaudeSdkAgentEntries(agents: unknown): ReadonlyArray<Record<string, unknown>> {
  if (Array.isArray(agents)) {
    return agents.filter((entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
    );
  }
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
    return [];
  }
  return Object.entries(agents as Record<string, unknown>).flatMap(([name, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [];
    }
    return [{ name, ...(value as Record<string, unknown>) }];
  });
}

function normalizeClaudeSdkStringList(value: unknown): string | string[] | undefined {
  if (typeof value === "string") {
    const values = splitFrontmatterListValue(value);
    if (values.length === 0) {
      return undefined;
    }
    return values.length === 1 ? values[0] : values;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  if (values.length === 0) {
    return undefined;
  }
  return values.length === 1 ? values[0] : values;
}

function defaultClaudeOutputStyles(): ClaudeOutputStyle[] {
  return [
    {
      value: "Default",
      name: "Default",
      description: "Claude Code's default software engineering style.",
    },
    {
      value: "Explanatory",
      name: "Explanatory",
      description: "Add educational insights while completing coding tasks.",
    },
    {
      value: "Learning",
      name: "Learning",
      description: "Collaborative learn-by-doing style with human TODOs.",
    },
  ];
}

function normalizeClaudeOutputStyleName(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 120) {
    return null;
  }
  return /^[\p{L}\p{N}][\p{L}\p{N} _.,:@/-]*$/u.test(normalized) ? normalized : null;
}

function readClaudeOutputStyleFile(file: string): ClaudeOutputStyle | null {
  if (!file.endsWith(".md")) {
    return null;
  }
  const markdown = safeReadFile(file);
  if (!markdown) {
    return null;
  }
  const name = normalizeClaudeOutputStyleName(
    frontmatterField(markdown, "name") ?? path.basename(file, ".md"),
  );
  if (!name) {
    return null;
  }
  const description = frontmatterField(markdown, "description") ?? firstMarkdownHeading(markdown);
  return {
    value: name,
    name,
    ...(description ? { description } : {}),
  };
}

function readClaudeOutputStyleRoot(root: string): ClaudeOutputStyle[] {
  if (!isDirectory(root)) {
    return [];
  }
  return safeReadDir(root)
    .map((entry) => readClaudeOutputStyleFile(path.join(root, entry)))
    .filter((style): style is ClaudeOutputStyle => style !== null);
}

function resolveClaudeCurrentOutputStyle(input: {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
}): string {
  let current = "Default";
  for (const settingsFile of claudeSettingsFiles(input)) {
    const settings = readClaudeSettingsFile(settingsFile);
    const outputStyle = normalizeClaudeOutputStyleName(
      typeof settings?.outputStyle === "string" ? settings.outputStyle : undefined,
    );
    if (outputStyle) {
      current = outputStyle;
    }
  }
  return current;
}

function mergeClaudeOutputStyles(
  styles: ReadonlyArray<ClaudeOutputStyle>,
): ReadonlyArray<ClaudeOutputStyle> {
  const byValue = new Map<string, ClaudeOutputStyle>();
  for (const style of styles) {
    const key = style.value.toLowerCase();
    if (!byValue.has(key)) {
      byValue.set(key, style);
    }
  }
  return [...byValue.values()].toSorted((left, right) => {
    const leftBuiltin = defaultClaudeOutputStyles().some((style) => style.value === left.value);
    const rightBuiltin = defaultClaudeOutputStyles().some((style) => style.value === right.value);
    if (leftBuiltin !== rightBuiltin) {
      return leftBuiltin ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

export function discoverClaudeOutputStyleConfigOption(input: {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
  readonly selectedOutputStyle?: string | undefined;
}): ProviderSessionConfigOption {
  const claudeHome = input.home?.trim() || path.join(homedir(), ".claude");
  const projectRoots = ancestorDirsUntilGitRoot(input.cwd);
  const pluginStyles = readClaudeInstalledPluginEntries(claudeHome).flatMap((entry) =>
    readClaudeOutputStyleRoot(path.join(entry.installPath, "output-styles")),
  );
  const outputStyles = mergeClaudeOutputStyles([
    ...defaultClaudeOutputStyles(),
    ...projectRoots.flatMap((root) =>
      readClaudeOutputStyleRoot(path.join(root, ".claude", "output-styles")),
    ),
    ...readClaudeOutputStyleRoot(path.join(claudeHome, "output-styles")),
    ...pluginStyles,
  ]);
  const selected =
    normalizeClaudeOutputStyleName(input.selectedOutputStyle) ??
    resolveClaudeCurrentOutputStyle(input);
  const hasSelected = outputStyles.some(
    (style) => style.value.toLowerCase() === selected.toLowerCase(),
  );
  const options = hasSelected
    ? outputStyles
    : mergeClaudeOutputStyles([{ value: selected, name: selected }, ...outputStyles]);

  return {
    id: "output_style",
    name: "Style",
    category: "output_style",
    type: "select",
    currentValue: selected,
    description: "Claude Code output style for this session.",
    options: options.map((style) => ({
      value: style.value,
      name: style.name,
      ...(style.description ? { description: style.description } : {}),
    })),
  };
}

function mergeProviderAgentOptions(
  commands: ReadonlyArray<ProviderSlashCommand>,
  defaultDescription: string,
): ReadonlyArray<ProviderSessionConfigOption["options"][number]> {
  const byValue = new Map<string, ProviderSessionConfigOption["options"][number]>();
  byValue.set("default", {
    value: "default",
    name: "Default",
    description: defaultDescription,
  });
  for (const command of commands) {
    if (command.kind !== "agent") {
      continue;
    }
    const value = normalizeCommandName(command.name);
    if (!value || byValue.has(value.toLowerCase())) {
      continue;
    }
    byValue.set(value.toLowerCase(), {
      value,
      name: command.name,
      ...(command.description ? { description: command.description } : {}),
    });
  }
  const [defaultOption, ...agentOptions] = [...byValue.values()];
  return [
    ...(defaultOption ? [defaultOption] : []),
    ...agentOptions.toSorted((left, right) => left.name.localeCompare(right.name)),
  ];
}

export function discoverClaudeAgentConfigOption(input: {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
  readonly selectedAgent?: string | undefined;
  readonly commands: ReadonlyArray<ProviderSlashCommand>;
}): ProviderSessionConfigOption {
  const settings = resolveClaudeAgentSettings(input);
  const selected =
    normalizeCommandName(input.selectedAgent ?? "") ?? settings.currentAgent ?? "default";
  const options = mergeProviderAgentOptions(
    input.commands,
    "Use Claude Code's default main agent for this session.",
  );
  const hasSelected = options.some(
    (option) => option.value.toLowerCase() === selected.toLowerCase(),
  );
  const resolvedOptions = hasSelected
    ? options
    : [
        ...options,
        {
          value: selected,
          name: selected,
          description: "Claude Code subagent selected for this session.",
        },
      ];

  return {
    id: "agent",
    name: "Agent",
    category: "agent",
    type: "select",
    currentValue: selected,
    description: "Claude Code main agent for this session.",
    options: resolvedOptions,
  };
}

export function discoverGitHubCopilotAgentConfigOption(input: {
  readonly selectedAgent?: string | undefined;
  readonly commands: ReadonlyArray<ProviderSlashCommand>;
}): ProviderSessionConfigOption {
  const selected = normalizeCommandName(input.selectedAgent ?? "") ?? "default";
  const options = mergeProviderAgentOptions(
    input.commands,
    "Use GitHub Copilot's default agent for this session.",
  );
  const hasSelected = options.some(
    (option) => option.value.toLowerCase() === selected.toLowerCase(),
  );
  const resolvedOptions = hasSelected
    ? options
    : [
        ...options,
        {
          value: selected,
          name: selected,
          description: "GitHub Copilot custom agent selected for this session.",
        },
      ];

  return {
    id: "agent",
    name: "Agent",
    category: "agent",
    type: "select",
    currentValue: selected,
    description: "GitHub Copilot custom agent for this session.",
    options: resolvedOptions,
  };
}

function claudeForkSubagentsEnabledFromEnv(env: NodeJS.ProcessEnv): boolean {
  return env.CLAUDE_CODE_FORK_SUBAGENT === "1";
}

function claudeAgentTeamsEnabledFromEnv(env: NodeJS.ProcessEnv): boolean {
  return env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === "1";
}

function claudeSubagentModelFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.CLAUDE_CODE_SUBAGENT_MODEL?.trim();
  return value && value.length > 0 ? value : undefined;
}

function claudeSubagentModelFromInput(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function discoverClaudeForkSubagentsConfigOption(
  input: {
    readonly selectedForkSubagents?: boolean | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
  } = {},
): ProviderSessionConfigOption {
  const selected =
    typeof input.selectedForkSubagents === "boolean"
      ? input.selectedForkSubagents
      : claudeForkSubagentsEnabledFromEnv(input.env ?? process.env);
  return {
    id: "fork_subagents",
    name: "Forks",
    category: "subagent_fork_mode",
    type: "select",
    currentValue: selected ? "on" : "off",
    description: "Claude Code forked subagents inherit the current conversation context.",
    options: [
      {
        value: "off",
        name: "Off",
        description: "Use named subagents with fresh task context.",
      },
      {
        value: "on",
        name: "On",
        description: "Enable Claude Code forked subagents for shared-context side tasks.",
      },
    ],
  };
}

export function discoverClaudeSubagentModelConfigOption(
  input: {
    readonly selectedSubagentModel?: string | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
  } = {},
): ProviderSessionConfigOption {
  const selected =
    claudeSubagentModelFromInput(input.selectedSubagentModel) ??
    claudeSubagentModelFromEnv(input.env ?? process.env) ??
    "inherit";
  const baseOptions = [
    {
      value: "inherit",
      name: "Inherit",
      description: "Use each Claude subagent's configured model or inherit from the parent.",
    },
    {
      value: "haiku",
      name: "Haiku",
      description: "Force Claude subagents onto the fast Haiku model alias.",
    },
    {
      value: "sonnet",
      name: "Sonnet",
      description: "Force Claude subagents onto the Sonnet model alias.",
    },
    {
      value: "opus",
      name: "Opus",
      description: "Force Claude subagents onto the Opus model alias.",
    },
  ];
  const options = baseOptions.some((option) => option.value === selected)
    ? baseOptions
    : [
        ...baseOptions,
        {
          value: selected,
          name: selected,
          description: "Claude subagent model selected from session settings.",
        },
      ];

  return {
    id: "subagent_model",
    name: "Subagent Model",
    category: "subagent_model",
    type: "select",
    currentValue: selected,
    description: "Claude Code model override for subagent invocations.",
    options,
  };
}

export function discoverClaudeAgentTeamsConfigOption(
  input: {
    readonly selectedAgentTeams?: boolean | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
  } = {},
): ProviderSessionConfigOption {
  const selected =
    typeof input.selectedAgentTeams === "boolean"
      ? input.selectedAgentTeams
      : claudeAgentTeamsEnabledFromEnv(input.env ?? process.env);
  return {
    id: "agent_teams",
    name: "Teams",
    category: "agent_team_mode",
    type: "select",
    currentValue: selected ? "on" : "off",
    description: "Claude Code experimental agent teams for peer-to-peer multi-agent work.",
    options: [
      {
        value: "off",
        name: "Off",
        description: "Keep Claude agent teams disabled for this session.",
      },
      {
        value: "on",
        name: "On",
        description: "Enable Claude Code agent teams for multi-agent collaboration.",
      },
    ],
  };
}

function stripJsonComments(raw: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      index += 2;
      while (index < raw.length && raw[index] !== "\n" && raw[index] !== "\r") {
        index += 1;
      }
      index -= 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < raw.length && !(raw[index] === "*" && raw[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function stripJsonTrailingCommas(raw: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === ",") {
      let nextIndex = index + 1;
      while (/\s/u.test(raw[nextIndex] ?? "")) {
        nextIndex += 1;
      }
      if (raw[nextIndex] === "}" || raw[nextIndex] === "]") {
        continue;
      }
    }
    output += char;
  }
  return output;
}

function safeParseJsoncRecord(file: string): Record<string, unknown> | null {
  const raw = safeReadFile(file);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(stripJsonTrailingCommas(stripJsonComments(raw))) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringArrayFromUnknown(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim().length > 0 ? [value.trim()] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function resolvePiResourcePaths(baseDir: string, value: unknown): string[] {
  return stringArrayFromUnknown(value).flatMap((rawPath) => {
    if (rawPath.startsWith("!") || rawPath.startsWith("-")) {
      return [];
    }
    const exactPath = rawPath.startsWith("+") ? rawPath.slice(1).trim() : rawPath;
    if (!exactPath || /[*?[\]{}]/u.test(exactPath)) {
      return [];
    }
    if (exactPath.startsWith("~/")) {
      return [path.join(homedir(), exactPath.slice(2))];
    }
    if (path.isAbsolute(exactPath)) {
      return [exactPath];
    }
    return [path.resolve(baseDir, exactPath)];
  });
}

function readPiPromptTemplateResource(resourcePath: string): ProviderSlashCommand[] {
  if (isDirectory(resourcePath)) {
    return readPiPromptTemplateRoot(resourcePath);
  }
  if (!isRegularFile(resourcePath)) {
    return [];
  }
  const command = readPiPromptTemplateCommand(resourcePath);
  return command ? [command] : [];
}

function readPiSkillResource(resourcePath: string): ProviderSlashCommand[] {
  if (isDirectory(resourcePath)) {
    const directCommand = readSkillCommand(resourcePath, PI_SKILL_READ_OPTIONS);
    return directCommand
      ? [directCommand]
      : readPiSkillRoot({ root: resourcePath, includeRootMarkdownFiles: true });
  }
  if (!isRegularFile(resourcePath)) {
    return [];
  }
  const command = readMarkdownSkillCommand(resourcePath, PI_SKILL_READ_OPTIONS);
  return command ? [command] : [];
}

function piPackagedAgentName(agentName: string, markdown: string): string {
  const packageName = normalizeCommandName(frontmatterField(markdown, "package") ?? "");
  return packageName ? `${packageName}.${agentName}` : agentName;
}

function piAgentMetadata(markdown: string): Record<string, unknown> | undefined {
  const packageName = frontmatterField(markdown, "package");
  const model = frontmatterField(markdown, "model");
  const tools = frontmatterStringOrListField(markdown, "tools");
  const agents = frontmatterStringOrListField(markdown, "agents");
  const thinking =
    frontmatterField(markdown, "thinking") ??
    frontmatterField(markdown, "thoughtLevel") ??
    frontmatterField(markdown, "thinking_level") ??
    frontmatterField(markdown, "thought_level");
  const metadata = {
    provider: "pi",
    source: "agent",
    ...(packageName ? { package: packageName } : {}),
    ...(model ? { model } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(agents !== undefined ? { agents } : {}),
    ...(thinking ? { thinking } : {}),
  };
  return Object.keys(metadata).length > 2 ? metadata : undefined;
}

function readPiAgentResource(resourcePath: string): ProviderSlashCommand[] {
  const options: AgentReadOptions = {
    excludeDisabled: true,
    promptPrefix: (agentName) => `@${agentName}`,
    normalizeFileName: (fileName) =>
      fileName.endsWith(".chain") ? "" : fileName.replace(/\.agent$/u, ""),
    transformName: piPackagedAgentName,
    metadata: piAgentMetadata,
  };
  if (isDirectory(resourcePath)) {
    return readPiAgentRoot(resourcePath, options);
  }
  if (!isRegularFile(resourcePath)) {
    return [];
  }
  if (path.basename(resourcePath).endsWith(".chain.md")) {
    return [];
  }
  const command = readAgentMarkdownCommand(resourcePath, options);
  return command ? [command] : [];
}

function readPiAgentRoot(
  root: string,
  options: AgentReadOptions,
  depth = 0,
): ProviderSlashCommand[] {
  if (!isDirectory(root)) {
    return [];
  }
  const commands: ProviderSlashCommand[] = [];
  for (const entry of safeReadDir(root)) {
    const entryPath = path.join(root, entry);
    if (entry.endsWith(".chain.md")) {
      continue;
    }
    const command = readAgentMarkdownCommand(entryPath, options);
    if (command) {
      commands.push(command);
    } else if (depth < 4 && isDirectory(entryPath)) {
      commands.push(...readPiAgentRoot(entryPath, options, depth + 1));
    }
  }
  return commands;
}

function resolvePiPackageResourcePaths(input: {
  readonly packageRoot: string;
  readonly manifestValue: unknown;
  readonly filterValue: unknown;
  readonly conventionalRoot: string;
}): string[] {
  if (Array.isArray(input.filterValue)) {
    return resolvePiResourcePaths(input.packageRoot, input.filterValue);
  }
  if (input.filterValue === false || input.filterValue === null) {
    return [];
  }
  if (input.filterValue !== undefined) {
    return resolvePiResourcePaths(input.packageRoot, input.filterValue);
  }
  return input.manifestValue === undefined
    ? [path.join(input.packageRoot, input.conventionalRoot)]
    : resolvePiResourcePaths(input.packageRoot, input.manifestValue);
}

function readPiPackageCommands(
  packageRoot: string,
  filters: Omit<PiPackageSourceEntry, "source"> = {},
): ReadonlyArray<ProviderSlashCommand> {
  const rawManifest = safeParseJsonRecord(path.join(packageRoot, "package.json"));
  if (!rawManifest) {
    return [];
  }
  const manifest = rawManifest as PiPackageManifest;
  const hasPiManifest = Boolean(manifest.pi && typeof manifest.pi === "object");
  const isPiPackage =
    hasPiManifest ||
    (Array.isArray(manifest.keywords) &&
      manifest.keywords.some((keyword) => keyword === "pi-package"));
  if (!isPiPackage) {
    return [];
  }
  const hasResourceFilters =
    filters.prompts !== undefined ||
    filters.skills !== undefined ||
    filters.agents !== undefined ||
    filters.extensions !== undefined;
  const promptResources = resolvePiPackageResourcePaths({
    packageRoot,
    manifestValue: hasPiManifest ? manifest.pi?.prompts : undefined,
    filterValue: hasResourceFilters ? (filters.prompts ?? []) : filters.prompts,
    conventionalRoot: "prompts",
  });
  const skillResources = resolvePiPackageResourcePaths({
    packageRoot,
    manifestValue: hasPiManifest ? manifest.pi?.skills : undefined,
    filterValue: hasResourceFilters ? (filters.skills ?? []) : filters.skills,
    conventionalRoot: "skills",
  });
  const agentResources = resolvePiPackageResourcePaths({
    packageRoot,
    manifestValue: hasPiManifest ? manifest.pi?.agents : undefined,
    filterValue: hasResourceFilters ? (filters.agents ?? []) : filters.agents,
    conventionalRoot: "agents",
  });
  return mergeProviderSlashCommands(
    agentResources.flatMap(readPiAgentResource),
    promptResources.flatMap(readPiPromptTemplateResource),
    skillResources.flatMap(readPiSkillResource),
  );
}

function readPiSettingsFile(file: string): PiSettingsFile | null {
  return safeParseJsonRecord(file) as PiSettingsFile | null;
}

function isLocalPiPackageSource(value: string): boolean {
  return (
    value.startsWith(".") ||
    value.startsWith("/") ||
    value.startsWith("~/") ||
    value.startsWith("+.") ||
    value.startsWith("+/") ||
    value.startsWith("+~/")
  );
}

function piPackageSourcesFromUnknown(value: unknown): PiPackageSourceEntry[] {
  if (typeof value === "string") {
    return value.trim().length > 0 ? [{ source: value.trim() }] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      return trimmed ? [{ source: trimmed }] : [];
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const packageEntry = entry as {
      readonly source?: unknown;
      readonly prompts?: unknown;
      readonly skills?: unknown;
      readonly agents?: unknown;
      readonly extensions?: unknown;
    };
    const source = packageEntry.source;
    if (typeof source !== "string" || source.trim().length === 0) {
      return [];
    }
    return [
      {
        source: source.trim(),
        ...(packageEntry.prompts !== undefined ? { prompts: packageEntry.prompts } : {}),
        ...(packageEntry.skills !== undefined ? { skills: packageEntry.skills } : {}),
        ...(packageEntry.agents !== undefined ? { agents: packageEntry.agents } : {}),
        ...(packageEntry.extensions !== undefined ? { extensions: packageEntry.extensions } : {}),
      },
    ];
  });
}

function readPiSettingsCommands(input: {
  readonly settingsFile: string;
  readonly baseDir: string;
}): ReadonlyArray<ProviderSlashCommand> {
  const settings = readPiSettingsFile(input.settingsFile);
  if (!settings) {
    return [];
  }
  const packageSources = piPackageSourcesFromUnknown(settings.packages).filter((entry) =>
    isLocalPiPackageSource(entry.source),
  );
  return mergeProviderSlashCommands(
    resolvePiResourcePaths(input.baseDir, settings.agents).flatMap(readPiAgentResource),
    resolvePiResourcePaths(input.baseDir, settings.prompts).flatMap(readPiPromptTemplateResource),
    resolvePiResourcePaths(input.baseDir, settings.skills).flatMap(readPiSkillResource),
    packageSources.flatMap((packageSource) =>
      resolvePiResourcePaths(input.baseDir, packageSource.source).flatMap((packageRoot) =>
        readPiPackageCommands(packageRoot, packageSource),
      ),
    ),
  );
}

function piDisabledBuiltinSubagentNames(settingsFiles: ReadonlyArray<string>): Set<string> {
  const disabled = new Set<string>();
  for (const settingsFile of settingsFiles) {
    const settings = readPiSettingsFile(settingsFile);
    const subagents =
      settings?.subagents && typeof settings.subagents === "object"
        ? (settings.subagents as {
            readonly disableBuiltins?: unknown;
            readonly agentOverrides?: unknown;
          })
        : null;
    if (!subagents) {
      continue;
    }
    if (subagents.disableBuiltins === true) {
      for (const command of PI_BUILT_IN_SUBAGENT_COMMANDS) {
        disabled.add(command.name);
      }
    }
    const overrides =
      subagents.agentOverrides && typeof subagents.agentOverrides === "object"
        ? (subagents.agentOverrides as Record<string, unknown>)
        : {};
    for (const [rawName, override] of Object.entries(overrides)) {
      const agentName = normalizeCommandName(rawName);
      if (!agentName || !override || typeof override !== "object") {
        continue;
      }
      if ((override as { readonly disabled?: unknown }).disabled === true) {
        disabled.add(agentName);
      }
    }
  }
  return disabled;
}

function filterPiBuiltinSubagentCommands(
  settingsFiles: ReadonlyArray<string>,
): ReadonlyArray<ProviderSlashCommand> {
  const disabled = piDisabledBuiltinSubagentNames(settingsFiles);
  if (disabled.size === 0) {
    return PI_BUILT_IN_SUBAGENT_COMMANDS;
  }
  return PI_BUILT_IN_SUBAGENT_COMMANDS.filter((command) => !disabled.has(command.name));
}

function piSkillCommandsEnabled(settingsFiles: ReadonlyArray<string>): boolean {
  let enabled = true;
  for (const settingsFile of settingsFiles.toReversed()) {
    const settings = readPiSettingsFile(settingsFile);
    if (typeof settings?.enableSkillCommands === "boolean") {
      enabled = settings.enableSkillCommands;
    }
  }
  return enabled;
}

function applyPiSettings(
  commands: ReadonlyArray<ProviderSlashCommand>,
  settingsFiles: ReadonlyArray<string>,
): ReadonlyArray<ProviderSlashCommand> {
  if (piSkillCommandsEnabled(settingsFiles)) {
    return commands;
  }
  return commands.filter((command) => command.kind !== "skill");
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
  const kind = frontmatterField(markdown, "kind")?.toLowerCase();
  if (
    options.includeMode &&
    ((!mode && !options.includeMissingMode) || (mode && !options.includeMode.has(mode)))
  ) {
    return null;
  }
  if (kind && options.excludeKind?.has(kind)) {
    return null;
  }
  if (frontmatterBooleanField(markdown, "hidden") === true) {
    return null;
  }
  if (
    options.excludeDisabled &&
    (frontmatterBooleanField(markdown, "disable") === true ||
      frontmatterBooleanField(markdown, "disabled") === true)
  ) {
    return null;
  }
  const frontmatterName = options.nameFromFrontmatter ? frontmatterField(markdown, "name") : null;
  if (options.requireNameFromFrontmatter && !frontmatterName) {
    return null;
  }
  const frontmatterDescription = frontmatterField(markdown, "description");
  if (options.requireDescription && !frontmatterDescription) {
    return null;
  }
  const description = frontmatterDescription ?? firstMarkdownHeading(markdown);
  const rawName =
    frontmatterName ??
    options.normalizeFileName?.(path.basename(file, ".md")) ??
    path.basename(file, ".md");
  const agentName = normalizeCommandName(options.transformName?.(rawName, markdown) ?? rawName);
  if (!agentName) {
    return null;
  }
  return providerAgentSlashCommand({
    name: agentName,
    description,
    promptPrefix: options.promptPrefix?.(agentName) ?? `@${agentName}`,
    inputHint: "<prompt>",
    metadata: options.metadata?.(markdown),
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

function sanitizedGeminiRemoteAgentAuthMetadata(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const auth = value as Record<string, unknown>;
  const type = typeof auth.type === "string" && auth.type.trim() ? auth.type.trim() : undefined;
  if (!type) {
    return undefined;
  }
  const scheme =
    typeof auth.scheme === "string" && auth.scheme.trim() ? auth.scheme.trim() : undefined;
  const scopes = Array.isArray(auth.scopes)
    ? auth.scopes.filter(
        (scope): scope is string => typeof scope === "string" && scope.trim().length > 0,
      )
    : undefined;
  const name = typeof auth.name === "string" && auth.name.trim() ? auth.name.trim() : undefined;
  const location =
    typeof auth.in === "string" && auth.in.trim()
      ? auth.in.trim()
      : typeof auth.location === "string" && auth.location.trim()
        ? auth.location.trim()
        : undefined;
  const authorizationUrl =
    typeof auth.authorization_url === "string" && auth.authorization_url.trim()
      ? auth.authorization_url.trim()
      : typeof auth.authorizationUrl === "string" && auth.authorizationUrl.trim()
        ? auth.authorizationUrl.trim()
        : undefined;
  const tokenUrl =
    typeof auth.token_url === "string" && auth.token_url.trim()
      ? auth.token_url.trim()
      : typeof auth.tokenUrl === "string" && auth.tokenUrl.trim()
        ? auth.tokenUrl.trim()
        : undefined;
  return {
    type,
    ...(scheme ? { scheme } : {}),
    ...(scopes && scopes.length > 0 ? { scopes } : {}),
    ...(name ? { name } : {}),
    ...(location ? { location } : {}),
    ...(authorizationUrl ? { authorizationUrl } : {}),
    ...(tokenUrl ? { tokenUrl } : {}),
  };
}

function geminiRemoteAgentCommandFromEntry(
  entry: Record<string, unknown>,
): ProviderSlashCommand | null {
  if (entry.kind !== "remote" || typeof entry.name !== "string") {
    return null;
  }
  const agentCardUrl = stringEntryField(entry, [
    "agent_card_url",
    "agentCardUrl",
    "agent-card-url",
  ]);
  const agentCardJson = stringEntryField(entry, [
    "agent_card_json",
    "agentCardJson",
    "agent-card-json",
  ]);
  if (!agentCardUrl && !agentCardJson) {
    return null;
  }
  const agentName = normalizeCommandName(entry.name);
  if (!agentName) {
    return null;
  }
  const description =
    typeof entry.description === "string"
      ? entry.description
      : agentCardUrl
        ? `Remote Gemini A2A subagent at ${agentCardUrl}`
        : "Remote Gemini A2A subagent";
  const auth = sanitizedGeminiRemoteAgentAuthMetadata(entry.auth);
  return providerAgentSlashCommand({
    name: agentName,
    description,
    promptPrefix: `@${agentName}`,
    inputHint: "<prompt>",
    metadata: {
      provider: "gemini",
      source: "remote-agent",
      kind: "remote",
      ...(agentCardUrl ? { agentCardUrl } : {}),
      ...(agentCardJson ? { agentCardJson } : {}),
      ...(auth ? { auth, authType: auth.type } : {}),
    },
  });
}

function stringEntryField(
  entry: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | undefined {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readGeminiRemoteAgentMarkdownCommands(file: string): ProviderSlashCommand[] {
  if (!file.endsWith(".md")) {
    return [];
  }
  const markdown = safeReadFile(file);
  if (!markdown) {
    return [];
  }
  const entries = frontmatterRootObjectList(markdown) ?? [
    {
      kind: frontmatterField(markdown, "kind") ?? "",
      name: frontmatterField(markdown, "name") ?? "",
      agent_card_url:
        frontmatterFieldAny(markdown, ["agent_card_url", "agentCardUrl", "agent-card-url"]) ?? "",
      agent_card_json:
        frontmatterBlockScalarFieldAny(markdown, [
          "agent_card_json",
          "agentCardJson",
          "agent-card-json",
        ]) ??
        frontmatterFieldAny(markdown, ["agent_card_json", "agentCardJson", "agent-card-json"]) ??
        "",
      description: frontmatterField(markdown, "description") ?? "",
      auth:
        frontmatterJsonObjectField(markdown, "auth") ??
        frontmatterYamlObjectField(markdown, "auth"),
    },
  ];
  return entries
    .map(geminiRemoteAgentCommandFromEntry)
    .filter((command): command is ProviderSlashCommand => command !== null);
}

function readGeminiRemoteAgentRoot(root: string, depth = 0): ProviderSlashCommand[] {
  if (!isDirectory(root)) {
    return [];
  }
  const commands: ProviderSlashCommand[] = [];
  for (const entry of safeReadDir(root)) {
    const entryPath = path.join(root, entry);
    commands.push(...readGeminiRemoteAgentMarkdownCommands(entryPath));
    if (depth < 4 && isDirectory(entryPath)) {
      commands.push(...readGeminiRemoteAgentRoot(entryPath, depth + 1));
    }
  }
  return commands;
}

function pluginAgentScopeSegments(root: string, file: string): string[] {
  const relativeDir = path.relative(root, path.dirname(file));
  if (!relativeDir || relativeDir === ".") {
    return [];
  }
  return relativeDir
    .split(path.sep)
    .map((part) => normalizeCommandName(part))
    .filter((part): part is string => Boolean(part));
}

function readPluginAgentMarkdownCommand(input: {
  readonly root: string;
  readonly file: string;
  readonly pluginName: string;
  readonly agentPromptPrefix?: ((pluginName: string, agentName: string) => string) | undefined;
}): ProviderSlashCommand | null {
  if (!input.file.endsWith(".md")) {
    return null;
  }
  const markdown = safeReadFile(input.file);
  if (!markdown) {
    return null;
  }
  if (frontmatterBooleanField(markdown, "hidden") === true) {
    return null;
  }
  const rawAgentName = frontmatterField(markdown, "name") ?? path.basename(input.file, ".md");
  const agentName = normalizeCommandName(rawAgentName);
  if (!agentName) {
    return null;
  }
  const scopedAgentName = [...pluginAgentScopeSegments(input.root, input.file), agentName].join(
    ":",
  );
  if (!scopedAgentName) {
    return null;
  }
  const description = frontmatterField(markdown, "description") ?? firstMarkdownHeading(markdown);
  return providerAgentSlashCommand({
    name: `${input.pluginName}:${scopedAgentName}`,
    description,
    promptPrefix:
      input.agentPromptPrefix?.(input.pluginName, scopedAgentName) ??
      `@${input.pluginName}:${scopedAgentName}`,
    inputHint: "<prompt>",
  });
}

function readPluginAgentMarkdownRoot(input: {
  readonly root: string;
  readonly scanRoot?: string | undefined;
  readonly pluginName: string;
  readonly agentPromptPrefix?: ((pluginName: string, agentName: string) => string) | undefined;
  readonly depth?: number | undefined;
}): ProviderSlashCommand[] {
  const depth = input.depth ?? 0;
  const scanRoot = input.scanRoot ?? input.root;
  if (!isDirectory(scanRoot)) {
    return [];
  }
  const commands: ProviderSlashCommand[] = [];
  for (const entry of safeReadDir(scanRoot)) {
    const entryPath = path.join(scanRoot, entry);
    const command = readPluginAgentMarkdownCommand({
      root: input.root,
      file: entryPath,
      pluginName: input.pluginName,
      ...(input.agentPromptPrefix ? { agentPromptPrefix: input.agentPromptPrefix } : {}),
    });
    if (command) {
      commands.push(command);
    } else if (depth < 4 && isDirectory(entryPath)) {
      commands.push(
        ...readPluginAgentMarkdownRoot({
          ...input,
          scanRoot: entryPath,
          depth: depth + 1,
        }),
      );
    }
  }
  return commands;
}

function openCodeAgentConfigEntries(parsed: {
  readonly agent?: unknown;
  readonly agents?: unknown;
}): ReadonlyArray<readonly [string, unknown]> {
  const agents = {
    ...(parsed.agent && typeof parsed.agent === "object"
      ? (parsed.agent as Record<string, unknown>)
      : {}),
    ...(parsed.agents && typeof parsed.agents === "object"
      ? (parsed.agents as Record<string, unknown>)
      : {}),
  };
  return Object.entries(agents);
}

function openCodeCommandConfigEntries(parsed: {
  readonly command?: unknown;
  readonly commands?: unknown;
}): ReadonlyArray<readonly [string, unknown]> {
  const commands = {
    ...(parsed.command && typeof parsed.command === "object"
      ? (parsed.command as Record<string, unknown>)
      : {}),
    ...(parsed.commands && typeof parsed.commands === "object"
      ? (parsed.commands as Record<string, unknown>)
      : {}),
  };
  return Object.entries(commands);
}

function isOpenCodeAgentDisabled(agent: {
  readonly disable?: unknown;
  readonly disabled?: unknown;
}): boolean {
  return agent.disable === true || agent.disabled === true;
}

function normalizeOpenCodePermissionValue(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value
      .map((item) => normalizeOpenCodePermissionValue(item))
      .filter((item): item is Exclude<unknown, undefined> => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (value && typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const [rawKey, rawNestedValue] of Object.entries(value as Record<string, unknown>)) {
      const key = rawKey.trim();
      if (!key) {
        continue;
      }
      const nestedValue = normalizeOpenCodePermissionValue(rawNestedValue);
      if (nestedValue !== undefined) {
        normalized[key] = nestedValue;
      }
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }
  return undefined;
}

function normalizeOpenCodePermission(
  permission: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  const normalized = normalizeOpenCodePermissionValue(permission);
  return normalized && typeof normalized === "object" && !Array.isArray(normalized)
    ? (normalized as Record<string, unknown>)
    : undefined;
}

function openCodeToolsFromValue(
  value: unknown,
): Record<string, unknown> | string | string[] | undefined {
  if (typeof value === "string") {
    const values = splitFrontmatterListValue(value);
    if (values.length === 0) {
      return undefined;
    }
    return values.length === 1 ? values[0] : values;
  }
  if (Array.isArray(value)) {
    const values = value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
    if (values.length === 0) {
      return undefined;
    }
    return values.length === 1 ? values[0] : values;
  }
  if (value && typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const [rawKey, rawNestedValue] of Object.entries(value as Record<string, unknown>)) {
      const key = rawKey.trim();
      if (!key) {
        continue;
      }
      const nestedValue = normalizeOpenCodePermissionValue(rawNestedValue);
      if (nestedValue !== undefined) {
        normalized[key] = nestedValue;
      }
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }
  return undefined;
}

function openCodeNumberFromValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function openCodeAgentMetadataFromRecord(
  agent: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const mode = typeof agent.mode === "string" && agent.mode.trim() ? agent.mode.trim() : undefined;
  const model =
    typeof agent.model === "string" && agent.model.trim() ? agent.model.trim() : undefined;
  const color =
    typeof agent.color === "string" && agent.color.trim() ? agent.color.trim() : undefined;
  const tools = openCodeToolsFromValue(agent.tools);
  const temperature = openCodeNumberFromValue(agent.temperature);
  const maxSteps = openCodeNumberFromValue(
    agent.maxSteps ?? agent.max_steps ?? agent["max-steps"] ?? agent.steps,
  );
  const permission =
    agent.permission && typeof agent.permission === "object" && !Array.isArray(agent.permission)
      ? (agent.permission as Record<string, unknown>)
      : null;
  const normalizedPermission = normalizeOpenCodePermission(permission);
  const taskPermission =
    permission?.task && typeof permission.task === "object" && !Array.isArray(permission.task)
      ? (permission.task as Record<string, unknown>)
      : undefined;
  const metadata = {
    provider: "opencode",
    source: "agent",
    ...(mode ? { mode } : {}),
    ...(model ? { model } : {}),
    ...(color ? { color } : {}),
    ...(tools ? { tools } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    ...(normalizedPermission ? { permission: normalizedPermission } : {}),
    ...(taskPermission ? { taskPermission } : {}),
  };
  return Object.keys(metadata).length > 2 ? metadata : undefined;
}

function openCodeAgentMetadataFromMarkdown(markdown: string): Record<string, unknown> | undefined {
  const metadata = openCodeAgentMetadataFromRecord({
    mode: frontmatterField(markdown, "mode"),
    model: frontmatterField(markdown, "model"),
    color: frontmatterField(markdown, "color"),
    tools:
      frontmatterStringOrListField(markdown, "tools") ??
      frontmatterJsonObjectField(markdown, "tools") ??
      frontmatterYamlObjectField(markdown, "tools"),
    temperature: frontmatterNumberField(markdown, "temperature"),
    maxSteps:
      frontmatterNumberFieldAny(markdown, ["maxSteps", "max-steps", "max_steps"]) ??
      frontmatterNumberField(markdown, "steps"),
    permission:
      frontmatterJsonObjectField(markdown, "permission") ??
      frontmatterYamlObjectField(markdown, "permission"),
  });
  return metadata;
}

function readOpenCodeJsonAgentCommands(file: string): ProviderSlashCommand[] {
  const parsed = safeParseJsoncRecord(file) as {
    readonly agent?: unknown;
    readonly agents?: unknown;
  } | null;
  if (!parsed) {
    return [];
  }
  try {
    return openCodeAgentConfigEntries(parsed).flatMap(([rawName, rawAgent]) => {
      const agentName = normalizeCommandName(rawName);
      if (!agentName || !rawAgent || typeof rawAgent !== "object") {
        return [];
      }
      const agent = rawAgent as {
        readonly description?: unknown;
        readonly mode?: unknown;
        readonly disable?: unknown;
        readonly disabled?: unknown;
        readonly hidden?: unknown;
        readonly model?: unknown;
        readonly color?: unknown;
        readonly permission?: unknown;
      };
      const description =
        typeof agent.description === "string" && agent.description.trim().length > 0
          ? agent.description.trim()
          : null;
      const mode = typeof agent.mode === "string" ? agent.mode.toLowerCase() : "all";
      if (
        !description ||
        isOpenCodeAgentDisabled(agent) ||
        agent.hidden === true ||
        (mode !== "subagent" && mode !== "all")
      ) {
        return [];
      }
      return [
        providerAgentSlashCommand({
          name: agentName,
          description,
          promptPrefix: `@${agentName}`,
          inputHint: "<prompt>",
          metadata: openCodeAgentMetadataFromRecord(agent as Record<string, unknown>),
        }),
      ];
    });
  } catch {
    return [];
  }
}

const OPENCODE_BUILT_IN_SUBAGENT_NAMES = new Set(["general", "explore", "scout"]);

function readOpenCodeJsonSubagentNames(file: string): Set<string> {
  const parsed = safeParseJsoncRecord(file) as {
    readonly agent?: unknown;
    readonly agents?: unknown;
  } | null;
  if (!parsed) {
    return new Set();
  }
  try {
    const subagentNames = new Set<string>();
    for (const [rawName, rawAgent] of openCodeAgentConfigEntries(parsed)) {
      const agentName = normalizeCommandName(rawName);
      if (!agentName || !rawAgent || typeof rawAgent !== "object") {
        continue;
      }
      const agent = rawAgent as {
        readonly description?: unknown;
        readonly mode?: unknown;
        readonly disable?: unknown;
        readonly disabled?: unknown;
        readonly hidden?: unknown;
      };
      const description =
        typeof agent.description === "string" && agent.description.trim().length > 0
          ? agent.description.trim()
          : null;
      const mode = typeof agent.mode === "string" ? agent.mode.toLowerCase() : "all";
      if (
        description &&
        !isOpenCodeAgentDisabled(agent) &&
        (mode === "subagent" || mode === "all")
      ) {
        subagentNames.add(agentName);
      }
    }
    return subagentNames;
  } catch {
    return new Set();
  }
}

function mergeOpenCodeSubagentNames(...sets: ReadonlyArray<ReadonlySet<string>>): Set<string> {
  const merged = new Set(OPENCODE_BUILT_IN_SUBAGENT_NAMES);
  for (const set of sets) {
    for (const name of set) {
      merged.add(name);
    }
  }
  return merged;
}

function hasOpenCodeSubagentName(
  subagentNames: ReadonlySet<string>,
  value: string | undefined,
): boolean {
  const normalized = normalizeCommandName(value ?? "");
  if (!normalized) {
    return false;
  }
  const normalizedLower = normalized.toLowerCase();
  for (const subagentName of subagentNames) {
    if (subagentName.toLowerCase() === normalizedLower) {
      return true;
    }
  }
  return false;
}

function readOpenCodeMarkdownSubagentName(file: string): string | null {
  if (!file.endsWith(".md")) {
    return null;
  }
  const markdown = safeReadFile(file);
  if (!markdown) {
    return null;
  }
  if (
    frontmatterBooleanField(markdown, "disable") === true ||
    frontmatterBooleanField(markdown, "disabled") === true
  ) {
    return null;
  }
  const mode = frontmatterField(markdown, "mode")?.toLowerCase() ?? "all";
  if (mode !== "subagent" && mode !== "all") {
    return null;
  }
  if (!frontmatterField(markdown, "description")) {
    return null;
  }
  const rawName = frontmatterField(markdown, "name") ?? path.basename(file, ".md");
  return normalizeCommandName(rawName);
}

function readOpenCodeMarkdownSubagentNames(root: string, depth = 0): Set<string> {
  const subagentNames = new Set<string>();
  if (!isDirectory(root) || depth > 4) {
    return subagentNames;
  }
  for (const entry of safeReadDir(root)) {
    const entryPath = path.join(root, entry);
    const subagentName = readOpenCodeMarkdownSubagentName(entryPath);
    if (subagentName) {
      subagentNames.add(subagentName);
    } else if (isDirectory(entryPath)) {
      for (const nestedSubagentName of readOpenCodeMarkdownSubagentNames(entryPath, depth + 1)) {
        subagentNames.add(nestedSubagentName);
      }
    }
  }
  return subagentNames;
}

function openCodeCommandMetadata(input: {
  readonly agent?: string | undefined;
  readonly subtask?: boolean | undefined;
  readonly model?: string | undefined;
}): Record<string, unknown> {
  return {
    provider: "opencode",
    source: "command",
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.subtask !== undefined ? { subtask: input.subtask } : {}),
    ...(input.model ? { model: input.model } : {}),
  };
}

function readOpenCodeJsonConfigCommands(
  file: string,
  subagentNames: ReadonlySet<string> = OPENCODE_BUILT_IN_SUBAGENT_NAMES,
): ProviderSlashCommand[] {
  const parsed = safeParseJsoncRecord(file) as {
    readonly command?: unknown;
    readonly commands?: unknown;
    readonly agent?: unknown;
    readonly agents?: unknown;
  } | null;
  if (!parsed) {
    return [];
  }
  try {
    const mergedSubagentNames = mergeOpenCodeSubagentNames(
      subagentNames,
      readOpenCodeJsonSubagentNames(file),
    );
    return openCodeCommandConfigEntries(parsed).flatMap(([rawName, rawCommand]) => {
      const commandName = normalizeCommandName(rawName);
      if (!commandName || !rawCommand || typeof rawCommand !== "object") {
        return [];
      }
      const command = rawCommand as {
        readonly description?: unknown;
        readonly template?: unknown;
        readonly agent?: unknown;
        readonly subtask?: unknown;
        readonly model?: unknown;
      };
      if (typeof command.template !== "string" || command.template.trim().length === 0) {
        return [];
      }
      const commandAgent =
        typeof command.agent === "string" && command.agent.trim().length > 0
          ? command.agent.trim()
          : undefined;
      const commandModel =
        typeof command.model === "string" && command.model.trim().length > 0
          ? command.model.trim()
          : undefined;
      const commandSubtask = typeof command.subtask === "boolean" ? command.subtask : undefined;
      const runsAsSubtask =
        commandSubtask === true ||
        (commandAgent !== undefined &&
          hasOpenCodeSubagentName(mergedSubagentNames, commandAgent) &&
          commandSubtask !== false);
      return [
        {
          name: commandName,
          kind: runsAsSubtask ? "agent" : "provider",
          promptPrefix: `/${commandName}`,
          inputHint: "<prompt>",
          metadata: openCodeCommandMetadata({
            agent: commandAgent,
            subtask: commandSubtask,
            model: commandModel,
          }),
          ...(typeof command.description === "string" && command.description.trim().length > 0
            ? { description: command.description.trim() }
            : {}),
        } satisfies ProviderSlashCommand,
      ];
    });
  } catch {
    return [];
  }
}

function readOpenCodeMarkdownCommand(
  file: string,
  subagentNames: ReadonlySet<string> = OPENCODE_BUILT_IN_SUBAGENT_NAMES,
  commandNameOverride?: string,
): ProviderSlashCommand | null {
  if (!file.endsWith(".md")) {
    return null;
  }
  const commandName = commandNameOverride ?? normalizeCommandName(path.basename(file, ".md"));
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
  const description = frontmatterField(markdown, "description") ?? firstMarkdownHeading(markdown);
  const subtask = frontmatterBooleanField(markdown, "subtask");
  const commandAgent = frontmatterField(markdown, "agent");
  const model = frontmatterField(markdown, "model");
  const runsAsSubtask =
    subtask === true || (hasOpenCodeSubagentName(subagentNames, commandAgent) && subtask !== false);
  return {
    name: commandName,
    kind: runsAsSubtask ? "agent" : "provider",
    promptPrefix: `/${commandName}`,
    inputHint: "<prompt>",
    metadata: openCodeCommandMetadata({
      agent: commandAgent,
      subtask,
      model,
    }),
    ...(description ? { description } : {}),
  };
}

function readOpenCodeMarkdownCommandRoot(
  root: string,
  subagentNames: ReadonlySet<string> = OPENCODE_BUILT_IN_SUBAGENT_NAMES,
): ProviderSlashCommand[] {
  return readOpenCodeMarkdownCommandRootRecursive(root, root, subagentNames);
}

function readOpenCodeMarkdownCommandRootRecursive(
  baseRoot: string,
  currentRoot: string,
  subagentNames: ReadonlySet<string>,
  depth = 0,
): ProviderSlashCommand[] {
  if (!isDirectory(currentRoot) || depth > 4) {
    return [];
  }
  const commands: ProviderSlashCommand[] = [];
  for (const entry of safeReadDir(currentRoot)) {
    const entryPath = path.join(currentRoot, entry);
    const commandName = openCodeMarkdownCommandName(baseRoot, entryPath);
    const command = readOpenCodeMarkdownCommand(entryPath, subagentNames, commandName ?? undefined);
    if (command) {
      commands.push(command);
    } else if (isDirectory(entryPath)) {
      commands.push(
        ...readOpenCodeMarkdownCommandRootRecursive(baseRoot, entryPath, subagentNames, depth + 1),
      );
    }
  }
  return commands;
}

function openCodeMarkdownCommandName(root: string, file: string): string | null {
  if (!file.endsWith(".md")) {
    return null;
  }
  return pathCommandSegment(path.relative(root, file.slice(0, -".md".length)));
}

function gitHubCopilotPromptCommandName(file: string): string | null {
  if (!file.endsWith(".prompt.md")) {
    return null;
  }
  return normalizeCommandName(path.basename(file, ".prompt.md"));
}

function gitHubCopilotPromptAgent(markdown: string): string | undefined {
  return normalizeCommandName(frontmatterField(markdown, "agent") ?? "") ?? undefined;
}

function gitHubCopilotPromptTools(markdown: string): string[] | undefined {
  return frontmatterStringListField(markdown, "tools");
}

function gitHubCopilotPromptPrefix(markdown: string, body: string): string {
  const agentName = gitHubCopilotPromptAgent(markdown);
  if (agentName) {
    return `@${agentName} ${body}`;
  }
  return gitHubCopilotPromptTools(markdown) ? `@agent ${body}` : body;
}

function gitHubCopilotPromptMetadata(markdown: string): Record<string, unknown> | undefined {
  const agent = gitHubCopilotPromptAgent(markdown);
  const model = frontmatterStringOrListField(markdown, "model");
  const tools = gitHubCopilotPromptTools(markdown);
  const metadata = {
    provider: "github-copilot",
    source: "prompt",
    ...(agent ? { agent } : tools ? { agent: "agent" } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(tools ? { tools } : {}),
  };
  return Object.keys(metadata).length > 2 ? metadata : undefined;
}

function gitHubCopilotInstructionMetadata(markdown: string): Record<string, unknown> | undefined {
  const applyTo =
    frontmatterStringOrListField(markdown, "applyTo") ??
    frontmatterStringOrListField(markdown, "apply-to");
  const metadata = {
    provider: "github-copilot",
    source: "instructions",
    ...(applyTo !== undefined ? { fileGlobs: applyTo } : {}),
  };
  return Object.keys(metadata).length > 2 ? metadata : undefined;
}

function gitHubCopilotSkillMetadata(markdown: string): Record<string, unknown> | undefined {
  const argumentsList = frontmatterArgumentNames(markdown);
  const tools = frontmatterStringOrListField(markdown, "tools");
  const model = frontmatterStringOrListField(markdown, "model");
  const disableModelInvocation = frontmatterBooleanFieldAny(
    markdown,
    DISABLE_MODEL_INVOCATION_FRONTMATTER_FIELDS,
  );
  const userInvocable = frontmatterBooleanFieldAny(markdown, USER_INVOCABLE_FRONTMATTER_FIELDS);
  const annotations = normalizeGitHubCopilotMetadata(
    frontmatterJsonObjectField(markdown, "metadata") ??
      frontmatterYamlObjectField(markdown, "metadata"),
  );
  const metadata = {
    provider: "github-copilot",
    source: "skill",
    ...(argumentsList ? { arguments: argumentsList } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}),
    ...(userInvocable !== undefined ? { userInvocable } : {}),
    ...(annotations ? { annotations } : {}),
  };
  return Object.keys(metadata).length > 2 ? metadata : undefined;
}

function readGitHubCopilotPromptCommand(file: string): ProviderSlashCommand | null {
  const markdown = safeReadFile(file);
  if (!markdown) {
    return null;
  }
  const commandName =
    normalizeCommandName(frontmatterField(markdown, "name") ?? "") ??
    gitHubCopilotPromptCommandName(file);
  if (!commandName) {
    return null;
  }
  const body = markdownBodyWithoutFrontmatter(markdown);
  if (!body) {
    return null;
  }
  const description = frontmatterField(markdown, "description") ?? firstMarkdownHeading(markdown);
  const metadata = gitHubCopilotPromptMetadata(markdown);
  return {
    name: commandName,
    kind: "provider",
    promptPrefix: gitHubCopilotPromptPrefix(markdown, body),
    inputHint: frontmatterField(markdown, "argument-hint") ?? "<prompt>",
    ...(description ? { description } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function readGitHubCopilotPromptRoot(root: string, depth = 0): ProviderSlashCommand[] {
  if (!isDirectory(root) || depth > 4) {
    return [];
  }
  const commands: ProviderSlashCommand[] = [];
  for (const entry of safeReadDir(root)) {
    const entryPath = path.join(root, entry);
    const command = readGitHubCopilotPromptCommand(entryPath);
    if (command) {
      commands.push(command);
    } else if (isDirectory(entryPath)) {
      commands.push(...readGitHubCopilotPromptRoot(entryPath, depth + 1));
    }
  }
  return commands;
}

function pathCommandSegment(value: string): string | null {
  return normalizeCommandName(
    value
      .split(path.sep)
      .filter((part) => part.length > 0)
      .join("-"),
  );
}

function gitHubCopilotRepositoryRoot(cwd?: string | undefined): string | null {
  return githubCopilotProjectRoots(cwd).at(-1) ?? null;
}

function gitHubCopilotInstructionCommandName(file: string): string | null {
  const basename = path.basename(file);
  if (basename.endsWith(".instructions.md")) {
    const commandName = normalizeCommandName(basename.slice(0, -".instructions.md".length));
    return commandName ? `instructions:${commandName}` : null;
  }
  if (basename === "AGENTS.md") {
    return "instructions:agents";
  }
  if (basename === "copilot-instructions.md") {
    return "instructions:copilot";
  }
  if (basename === "CLAUDE.md") {
    return "instructions:claude";
  }
  if (basename === "CLAUDE.local.md") {
    return "instructions:claude-local";
  }
  if (basename === "GEMINI.md") {
    return "instructions:gemini";
  }
  return null;
}

function gitHubCopilotScopedInstructionCommandName(input: {
  readonly file: string;
  readonly repositoryRoot?: string | null | undefined;
}): string | null {
  const commandName = gitHubCopilotInstructionCommandName(input.file);
  if (!commandName || !isRegularFile(input.file)) {
    return null;
  }
  if (!input.repositoryRoot || !path.basename(input.file).endsWith(".md")) {
    return commandName;
  }

  const parent = path.dirname(input.file);
  const repositoryRoot = path.resolve(input.repositoryRoot);
  const relativeParent = path.relative(repositoryRoot, parent);
  const isRepositoryRootFile = relativeParent === "";
  const githubInstructionsRoot = path.join(".github", "instructions");
  const isRepositoryGithubFile =
    relativeParent === ".github" || relativeParent === githubInstructionsRoot;
  const isRepositoryClaudeFile = relativeParent === ".claude";
  if (isRepositoryRootFile || isRepositoryGithubFile || isRepositoryClaudeFile) {
    return commandName;
  }

  if (relativeParent.startsWith(`${githubInstructionsRoot}${path.sep}`)) {
    const scope = pathCommandSegment(path.relative(githubInstructionsRoot, relativeParent));
    return scope ? `${commandName}:${scope}` : commandName;
  }

  const scope = pathCommandSegment(relativeParent);
  return scope ? `${commandName}:${scope}` : commandName;
}

function readGitHubCopilotInstructionCommand(input: {
  readonly file: string;
  readonly repositoryRoot?: string | null | undefined;
}): ProviderSlashCommand | null {
  const commandName = gitHubCopilotScopedInstructionCommandName(input);
  if (!commandName || !isRegularFile(input.file)) {
    return null;
  }
  const markdown = safeReadFile(input.file);
  if (!markdown) {
    return null;
  }
  const body = markdownBodyWithoutFrontmatter(markdown);
  if (!body) {
    return null;
  }
  const description =
    frontmatterField(markdown, "description") ??
    frontmatterField(markdown, "name") ??
    firstMarkdownHeading(markdown) ??
    (commandName.startsWith("instructions:agents")
      ? "Repository agent instructions"
      : commandName.startsWith("instructions:copilot")
        ? "Copilot instructions"
        : "Custom instructions");
  const metadata = gitHubCopilotInstructionMetadata(markdown);
  return {
    name: commandName,
    kind: "provider",
    promptPrefix: body,
    inputHint: "<prompt>",
    description,
    ...(metadata ? { metadata } : {}),
  };
}

function readGitHubCopilotInstructionRoot(input: {
  readonly root: string;
  readonly repositoryRoot?: string | null | undefined;
  readonly depth?: number | undefined;
}): ProviderSlashCommand[] {
  const depth = input.depth ?? 0;
  if (!isDirectory(input.root) || depth > 5) {
    return [];
  }
  const commands: ProviderSlashCommand[] = [];
  for (const entry of safeReadDir(input.root)) {
    const entryPath = path.join(input.root, entry);
    const command = readGitHubCopilotInstructionCommand({
      file: entryPath,
      repositoryRoot: input.repositoryRoot,
    });
    if (command) {
      commands.push(command);
    } else if (isDirectory(entryPath)) {
      commands.push(
        ...readGitHubCopilotInstructionRoot({
          root: entryPath,
          repositoryRoot: input.repositoryRoot,
          depth: depth + 1,
        }),
      );
    }
  }
  return commands;
}

function readCodexCustomPromptCommand(file: string): ProviderSlashCommand | null {
  if (!file.endsWith(".md")) {
    return null;
  }
  const rawName = path.basename(file, ".md");
  if (rawName.startsWith("_")) {
    return null;
  }
  const commandName = normalizeCommandName(rawName);
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
  const name = `prompts:${commandName}`;
  const description = frontmatterField(markdown, "description") ?? firstMarkdownHeading(markdown);
  return {
    name,
    kind: "provider",
    promptPrefix: `/${name}`,
    inputHint: frontmatterField(markdown, "argument-hint") ?? "<prompt>",
    ...(description ? { description } : {}),
  };
}

function readCodexCustomPromptRoot(root: string): ProviderSlashCommand[] {
  if (!isDirectory(root)) {
    return [];
  }
  return safeReadDir(root)
    .map((entry) => readCodexCustomPromptCommand(path.join(root, entry)))
    .filter((command): command is ProviderSlashCommand => command !== null);
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

function claudeMarkdownCommandName(input: {
  readonly root: string;
  readonly file: string;
}): string | null {
  if (!input.file.endsWith(".md")) {
    return null;
  }
  const relative = path.relative(input.root, input.file);
  if (relative.startsWith("..")) {
    return null;
  }
  const withoutExtension = relative.slice(0, -".md".length);
  if (withoutExtension.split(path.sep).some((part) => part.length === 0 || part.startsWith("_"))) {
    return null;
  }
  return normalizeCommandName(path.basename(withoutExtension));
}

function readClaudeMarkdownCommand(input: {
  readonly root: string;
  readonly file: string;
}): ProviderSlashCommand | null {
  const commandName = claudeMarkdownCommandName(input);
  if (!commandName) {
    return null;
  }
  const markdown = safeReadFile(input.file);
  if (!markdown) {
    return null;
  }
  const description = frontmatterField(markdown, "description") ?? firstMarkdownHeading(markdown);
  const metadata = claudeCommandMetadata(markdown, "command");
  return {
    name: commandName,
    kind: "provider",
    promptPrefix: `/${commandName}`,
    inputHint: frontmatterArgumentHint(markdown),
    ...(metadata ? { metadata } : {}),
    ...(description ? { description } : {}),
  };
}

function readClaudeMarkdownCommandRoot(
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
    const command = readClaudeMarkdownCommand({ root: commandRoot, file: entryPath });
    if (command) {
      commands.push(command);
    } else if (isDirectory(entryPath)) {
      commands.push(...readClaudeMarkdownCommandRoot(commandRoot, entryPath, depth + 1));
    }
  }
  return commands;
}

function cursorMarkdownCommandName(input: {
  readonly root: string;
  readonly file: string;
}): string | null {
  if (!input.file.endsWith(".md")) {
    return null;
  }
  const relative = path.relative(input.root, input.file);
  if (relative.startsWith("..")) {
    return null;
  }
  const withoutExtension = relative.slice(0, -".md".length);
  if (withoutExtension.split(path.sep).some((part) => part.length === 0 || part.startsWith("_"))) {
    return null;
  }
  return normalizeCommandName(withoutExtension.split(path.sep).join(":"));
}

function readCursorMarkdownCommand(input: {
  readonly root: string;
  readonly file: string;
}): ProviderSlashCommand | null {
  const commandName = cursorMarkdownCommandName(input);
  if (!commandName) {
    return null;
  }
  const markdown = safeReadFile(input.file);
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
    metadata: {
      provider: "cursor",
      source: "command",
    },
  });
}

function readCursorMarkdownCommandRoot(
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
    const command = readCursorMarkdownCommand({ root: commandRoot, file: entryPath });
    if (command) {
      commands.push(command);
    } else if (isDirectory(entryPath)) {
      commands.push(...readCursorMarkdownCommandRoot(commandRoot, entryPath, depth + 1));
    }
  }
  return commands;
}

function readCursorRuleCommand(root: string, file: string): ProviderSlashCommand | null {
  if (!file.endsWith(".mdc")) {
    return null;
  }
  const ruleName = pathCommandSegment(path.relative(root, file.slice(0, -".mdc".length)));
  if (!ruleName) {
    return null;
  }
  const markdown = safeReadFile(file);
  if (!markdown) {
    return null;
  }
  const description =
    frontmatterField(markdown, "description") ?? firstMarkdownHeading(markdown) ?? ruleName;
  return providerSkillSlashCommand({
    name: `rule:${ruleName}`,
    description,
    promptPrefix: `@${ruleName}`,
    inputHint: "<prompt>",
    metadata: cursorRuleMetadata(markdown, "rule"),
  });
}

function readCursorRuleRoot(root: string): ProviderSlashCommand[] {
  return readCursorRuleRootRecursive(root, root);
}

function readCursorRuleRootRecursive(
  root: string,
  currentRoot: string,
  depth = 0,
): ProviderSlashCommand[] {
  if (!isDirectory(currentRoot)) {
    return [];
  }
  const commands: ProviderSlashCommand[] = [];
  for (const entry of safeReadDir(currentRoot)) {
    const entryPath = path.join(currentRoot, entry);
    const command = readCursorRuleCommand(root, entryPath);
    if (command) {
      commands.push(command);
    } else if (depth < 4 && isDirectory(entryPath)) {
      commands.push(...readCursorRuleRootRecursive(root, entryPath, depth + 1));
    }
  }
  return commands;
}

const CURSOR_RULE_SCAN_SKIP_DIRS = new Set([
  ".cache",
  ".cursor",
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

function discoverCursorProjectRuleRoots(input: {
  readonly projectRoot: string | null;
  readonly projectRoots: ReadonlyArray<string>;
}): string[] {
  const roots = new Set(input.projectRoots.map((root) => path.join(root, ".cursor", "rules")));
  const projectRoot = input.projectRoot;
  if (!projectRoot || !isDirectory(projectRoot)) {
    return [...roots];
  }
  let visitedDirs = 0;
  const visit = (dir: string, depth: number): void => {
    if (depth > 5 || visitedDirs > 3000) {
      return;
    }
    visitedDirs += 1;
    const ruleRoot = path.join(dir, ".cursor", "rules");
    if (isDirectory(ruleRoot)) {
      roots.add(ruleRoot);
    }
    for (const entry of safeReadDir(dir)) {
      if (CURSOR_RULE_SCAN_SKIP_DIRS.has(entry)) {
        continue;
      }
      const child = path.join(dir, entry);
      if (isDirectory(child)) {
        visit(child, depth + 1);
      }
    }
  };
  visit(projectRoot, 0);
  return [...roots];
}

function cursorProjectRoot(cwd: string | undefined): string | null {
  const roots = ancestorDirsUntilGitRoot(cwd);
  return roots.find((root) => existsSync(path.join(root, ".git"))) ?? roots[0] ?? null;
}

function readCursorPlainRuleFile(input: {
  readonly file: string;
  readonly name: string;
  readonly fallbackDescription: string;
}): ProviderSlashCommand | null {
  const markdown = safeReadFile(input.file);
  if (!markdown) {
    return null;
  }
  const body = markdownBodyWithoutFrontmatter(markdown);
  if (!body) {
    return null;
  }
  return providerSkillSlashCommand({
    name: `rule:${input.name}`,
    description:
      frontmatterField(markdown, "description") ??
      firstMarkdownHeading(markdown) ??
      input.fallbackDescription,
    promptPrefix: body,
    inputHint: "<prompt>",
    metadata: cursorRuleMetadata(markdown, "rule"),
  });
}

function cursorRuleMetadata(markdown: string, source: "rule" | "command"): Record<string, unknown> {
  const globs = frontmatterStringOrListField(markdown, "globs");
  const alwaysApply = frontmatterBooleanField(markdown, "alwaysApply");
  return {
    provider: "cursor",
    source,
    ...(globs !== undefined ? { globs } : {}),
    ...(alwaysApply !== undefined ? { alwaysApply } : {}),
  };
}

function readCursorProjectContextRules(projectRoot: string | null): ProviderSlashCommand[] {
  if (!projectRoot) {
    return [];
  }
  return [
    readCursorPlainRuleFile({
      file: path.join(projectRoot, "AGENTS.md"),
      name: "agents",
      fallbackDescription: "Cursor AGENTS.md project instructions",
    }),
    readCursorPlainRuleFile({
      file: path.join(projectRoot, ".cursorrules"),
      name: "cursorrules",
      fallbackDescription: "Legacy Cursor project rules",
    }),
    readCursorPlainRuleFile({
      file: path.join(projectRoot, "CLAUDE.md"),
      name: "claude",
      fallbackDescription: "Cursor CLI Claude compatibility instructions",
    }),
  ].filter((command): command is ProviderSlashCommand => command !== null);
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
  const multilineMatch = new RegExp(
    `^${field}\\s*=\\s*(?<quote>"""|''')(?<value>[\\s\\S]*?)\\k<quote>\\s*$`,
    "mu",
  ).exec(toml);
  const multilineValue = multilineMatch?.groups?.value?.trim();
  if (multilineValue) {
    return multilineValue;
  }
  const match = new RegExp(
    `^${field}\\s*=\\s*(?<quote>["'])(?<value>.*?)\\k<quote>\\s*$`,
    "mu",
  ).exec(toml);
  const value = match?.groups?.value?.trim();
  return value || undefined;
}

function frontmatterTomlStringArrayField(toml: string, field: string): string[] | undefined {
  const match = new RegExp(`^${field}\\s*=\\s*\\[(?<value>[^\\]]*)\\]\\s*$`, "mu").exec(toml);
  const rawValue = match?.groups?.value;
  if (!rawValue) {
    return undefined;
  }
  const values = [...rawValue.matchAll(/(?<quote>["'])(?<value>.*?)\k<quote>/gu)]
    .map((item) => item.groups?.value?.trim())
    .filter((value): value is string => Boolean(value));
  return values.length > 0 ? values : undefined;
}

function geminiTomlCommandMetadata(prompt: string): Record<string, unknown> | undefined {
  const metadata = {
    provider: "gemini",
    source: "command",
    ...(prompt.includes("{{args}}") ? { arguments: ["args"] } : {}),
    ...(/!\{[\s\S]*?\}/u.test(prompt) ? { shellInjection: true } : {}),
    ...(/@\{[\s\S]*?\}/u.test(prompt) ? { fileInjection: true } : {}),
  };
  return Object.keys(metadata).length > 2 ? metadata : undefined;
}

function readGeminiExtensionTomlCommand(input: {
  readonly root: string;
  readonly file: string;
  readonly kind?: ProviderSlashCommand["kind"] | undefined;
}): ProviderSlashCommand | null {
  const commandName = geminiCommandNameFromTomlPath(input.root, input.file);
  if (!commandName) {
    return null;
  }
  const toml = safeReadFile(input.file);
  if (!toml) {
    return null;
  }
  const prompt = frontmatterTomlStringField(toml, "prompt");
  if (!prompt) {
    return null;
  }
  const metadata = geminiTomlCommandMetadata(prompt);
  const command = {
    name: commandName,
    kind: input.kind ?? "plugin",
    description:
      frontmatterTomlStringField(toml, "description") ??
      commandName
        .split(":")
        .join(" ")
        .replace(/\b\w/gu, (char) => char.toUpperCase()),
    promptPrefix: prompt,
    inputHint: "<prompt>",
    ...(metadata ? { metadata } : {}),
  } satisfies ProviderSlashCommand;
  return command.kind === "plugin" ? providerPluginSlashCommand(command) : command;
}

function readGeminiExtensionTomlCommandRoot(
  commandRoot: string,
  currentRoot = commandRoot,
  depth = 0,
  kind?: ProviderSlashCommand["kind"] | undefined,
): ProviderSlashCommand[] {
  if (!isDirectory(currentRoot) || depth > 4) {
    return [];
  }
  const commands: ProviderSlashCommand[] = [];
  for (const entry of safeReadDir(currentRoot)) {
    const entryPath = path.join(currentRoot, entry);
    const command = readGeminiExtensionTomlCommand({ root: commandRoot, file: entryPath, kind });
    if (command) {
      commands.push(command);
    } else if (isDirectory(entryPath)) {
      commands.push(...readGeminiExtensionTomlCommandRoot(commandRoot, entryPath, depth + 1, kind));
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

function pluginManifestPathEntries(value: string | ReadonlyArray<string> | undefined): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function readPluginCommands(input: {
  readonly pluginJsonPath: string;
  readonly manifestDirName: string;
  readonly includeMarkdownCommands?: boolean | undefined;
  readonly pluginPromptPrefix?: (pluginName: string) => string;
  readonly skillPromptPrefix?: (commandName: string, skillName: string) => string;
  readonly skillMetadata?: (markdown: string) => Record<string, unknown> | undefined;
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
    ...(input.skillMetadata ? { skillMetadata: input.skillMetadata } : {}),
    ...(input.agentPromptPrefix ? { agentPromptPrefix: input.agentPromptPrefix } : {}),
  });
}

function readPluginRootCommands(input: {
  readonly manifest: PluginManifest | null;
  readonly pluginRoot: string;
  readonly pluginName: string;
  readonly includeMarkdownCommands?: boolean | undefined;
  readonly includeRootSkillFallback?: boolean | undefined;
  readonly pluginPromptPrefix?: (pluginName: string) => string;
  readonly skillPromptPrefix?: (commandName: string, skillName: string) => string;
  readonly skillMetadata?: (markdown: string) => Record<string, unknown> | undefined;
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
  const skillPaths = pluginManifestPathEntries(input.manifest?.skills);
  if (skillPaths.length > 0) {
    for (const skillPath of skillPaths) {
      commands.push(
        ...readSkillRoot(path.resolve(input.pluginRoot, skillPath), {
          prefix: pluginName,
          ...(input.skillPromptPrefix ? { promptPrefix: input.skillPromptPrefix } : {}),
          ...(input.skillMetadata ? { metadata: input.skillMetadata } : {}),
        }),
      );
    }
  }
  if (skillPaths.length === 0 && input.includeRootSkillFallback) {
    const rootSkill = readSkillCommand(input.pluginRoot, {
      ...(input.skillPromptPrefix ? { promptPrefix: input.skillPromptPrefix } : {}),
      ...(input.skillMetadata ? { metadata: input.skillMetadata } : {}),
      nameFromFrontmatter: true,
    });
    if (rootSkill) {
      commands.push(rootSkill);
    }
  }
  for (const agentPath of pluginManifestPathEntries(input.manifest?.agents)) {
    commands.push(
      ...readPluginAgentMarkdownRoot({
        root: path.resolve(input.pluginRoot, agentPath),
        pluginName,
        ...(input.agentPromptPrefix ? { agentPromptPrefix: input.agentPromptPrefix } : {}),
      }),
    );
  }
  if (input.includeMarkdownCommands) {
    for (const commandPath of pluginManifestPathEntries(input.manifest?.commands)) {
      commands.push(
        ...readPluginMarkdownCommandRoot({
          root: path.resolve(input.pluginRoot, commandPath),
          pluginName,
        }),
      );
    }
  }
  return commands;
}

const GITHUB_COPILOT_PLUGIN_MANIFEST_CANDIDATES = [
  [".plugin", "plugin.json"],
  ["plugin.json"],
  [".github", "plugin.json"],
  [".github", "plugin", "plugin.json"],
  [".claude-plugin", "plugin.json"],
] as const;

type GitHubCopilotPluginEntry = {
  readonly pluginRoot: string;
  readonly manifestPath?: string | undefined;
};

function githubCopilotPluginManifestPath(pluginRoot: string): string | null {
  for (const parts of GITHUB_COPILOT_PLUGIN_MANIFEST_CANDIDATES) {
    const candidate = path.join(pluginRoot, ...parts);
    if (isRegularFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

function githubCopilotPluginEntries(root: string, depth = 0): GitHubCopilotPluginEntry[] {
  if (!isDirectory(root) || depth > 5) {
    return [];
  }

  const manifest = githubCopilotPluginManifestPath(root);
  if (manifest) {
    return [
      {
        pluginRoot: githubCopilotPluginRootFromManifest(manifest),
        manifestPath: manifest,
      },
    ];
  }

  if (isRegularFile(path.join(root, "SKILL.md"))) {
    return [{ pluginRoot: root }];
  }

  return safeReadDir(root).flatMap((entry) =>
    githubCopilotPluginEntries(path.join(root, entry), depth + 1),
  );
}

function githubCopilotPluginRootFromManifest(manifestPath: string): string {
  const parent = path.dirname(manifestPath);
  if (path.basename(parent) === ".plugin" || path.basename(parent) === ".claude-plugin") {
    return path.dirname(parent);
  }
  if (path.basename(parent) === ".github") {
    return path.dirname(parent);
  }
  if (path.basename(parent) === "plugin" && path.basename(path.dirname(parent)) === ".github") {
    return path.dirname(path.dirname(parent));
  }
  return parent;
}

function withGitHubCopilotPluginDefaults(
  manifest: PluginManifest,
  pluginRoot: string,
): PluginManifest {
  const defaultAgents = isDirectory(path.join(pluginRoot, "agents")) ? "agents" : undefined;
  const defaultSkills = isDirectory(path.join(pluginRoot, "skills")) ? "skills" : undefined;
  const defaultCommands = isDirectory(path.join(pluginRoot, "commands")) ? "commands" : undefined;
  const agents = manifest.agents ?? defaultAgents;
  const skills = manifest.skills ?? defaultSkills;
  const commands = manifest.commands ?? defaultCommands;
  return {
    ...manifest,
    ...(agents ? { agents } : {}),
    ...(skills ? { skills } : {}),
    ...(commands ? { commands } : {}),
  };
}

function readGitHubCopilotPluginCommands(pluginJsonPath: string): ProviderSlashCommand[] {
  const manifest = safeParsePluginManifest(pluginJsonPath);
  const pluginRoot = githubCopilotPluginRootFromManifest(pluginJsonPath);
  const pluginName = normalizeCommandName(manifest?.name ?? path.basename(pluginRoot));
  if (!manifest || !pluginName) {
    return [];
  }
  return readPluginRootCommands({
    manifest: withGitHubCopilotPluginDefaults(manifest, pluginRoot),
    pluginRoot,
    pluginName,
    includeMarkdownCommands: true,
    includeRootSkillFallback: true,
    pluginPromptPrefix: naturalPluginPromptPrefix,
    skillPromptPrefix: (commandName) => `/${commandName}`,
    agentPromptPrefix: (_pluginName, agentName) => `@${agentName}`,
  });
}

function readGitHubCopilotPluginEntryCommands(
  entry: GitHubCopilotPluginEntry,
): ProviderSlashCommand[] {
  if (entry.manifestPath) {
    return readGitHubCopilotPluginCommands(entry.manifestPath);
  }
  const rootSkill = readSkillCommand(entry.pluginRoot, {
    nameFromFrontmatter: true,
    promptPrefix: (commandName) => `/${commandName}`,
  });
  return rootSkill ? [rootSkill] : [];
}

export function discoverGitHubCopilotPluginSlashCommands(
  input: {
    readonly home?: string | undefined;
  } = {},
): ReadonlyArray<ProviderSlashCommand> {
  return mergeProviderSlashCommands(
    githubCopilotPluginRoots(input.home).flatMap((root) =>
      githubCopilotPluginEntries(root).flatMap(readGitHubCopilotPluginEntryCommands),
    ),
  );
}

export function discoverGitHubCopilotPluginDirectories(
  input: {
    readonly home?: string | undefined;
  } = {},
): ReadonlyArray<string> {
  return uniquePaths(
    githubCopilotPluginRoots(input.home).flatMap((root) =>
      githubCopilotPluginEntries(root).map((entry) => entry.pluginRoot),
    ),
  );
}

export function discoverCodexExtensionSlashCommands(
  input: CommandInput,
): ReadonlyArray<ProviderSlashCommand> {
  const codexHome = input.codexHome?.trim() || path.join(homedir(), ".codex");
  const userAgentsHome = input.agentsHome?.trim() || path.join(homedir(), ".agents");
  const projectRoots = ancestorDirsUntilGitRoot(input.cwd);
  const skillRoots = uniquePaths([
    ...projectRoots.flatMap((root) => [
      path.join(root, ".codex", "skills"),
      path.join(root, ".agents", "skills"),
    ]),
    path.join(codexHome, "skills"),
    path.join(userAgentsHome, "skills"),
    "/etc/codex/skills",
  ]);

  const skillCommands = skillRoots.flatMap((root) => readSkillRoot(root));
  const customPromptCommands = readCodexCustomPromptRoot(path.join(codexHome, "prompts"));
  const agentCommands = uniquePaths([
    ...projectRoots.map((root) => path.join(root, ".codex", "agents")),
    path.join(codexHome, "agents"),
  ]).flatMap((root) => readCodexAgentRoot(root));
  const pluginCommands = pluginManifestFiles(
    path.join(codexHome, "plugins", "cache"),
    ".codex-plugin",
  ).flatMap((pluginJsonPath) =>
    readPluginCommands({
      pluginJsonPath,
      manifestDirName: ".codex-plugin",
    }),
  );

  return mergeProviderSlashCommands(
    skillCommands,
    agentCommands,
    customPromptCommands,
    pluginCommands,
  );
}

function readCodexAgentRoot(root: string): ProviderSlashCommand[] {
  if (!isDirectory(root)) {
    return [];
  }
  return safeReadDir(root)
    .map((entry) => path.join(root, entry))
    .filter((file) => file.endsWith(".toml") && isRegularFile(file))
    .map(readCodexAgentTomlCommand)
    .filter((command): command is ProviderSlashCommand => command !== null);
}

function codexAgentTomlMetadata(toml: string): Record<string, unknown> {
  const nicknameCandidates = frontmatterTomlStringArrayField(toml, "nickname_candidates");
  const model = frontmatterTomlStringField(toml, "model");
  const modelReasoningEffort = frontmatterTomlStringField(toml, "model_reasoning_effort");
  const sandboxMode = frontmatterTomlStringField(toml, "sandbox_mode");
  return {
    provider: "codex",
    source: "agent",
    ...(model ? { model } : {}),
    ...(modelReasoningEffort ? { modelReasoningEffort } : {}),
    ...(sandboxMode ? { sandboxMode } : {}),
    ...(nicknameCandidates ? { nicknameCandidates } : {}),
  };
}

function readCodexAgentTomlCommand(file: string): ProviderSlashCommand | null {
  const toml = safeReadFile(file);
  if (!toml) {
    return null;
  }
  const name = normalizeCommandName(frontmatterTomlStringField(toml, "name") ?? "");
  const description = frontmatterTomlStringField(toml, "description");
  const developerInstructions = frontmatterTomlStringField(toml, "developer_instructions");
  if (!name || !description || !developerInstructions) {
    return null;
  }
  return providerAgentSlashCommand({
    name,
    description,
    promptPrefix: `@${name}`,
    inputHint: "<prompt>",
    metadata: codexAgentTomlMetadata(toml),
  });
}

function discoverSkillRootSlashCommands(input: {
  readonly roots: ReadonlyArray<string | null | undefined>;
  readonly skillPromptPrefix?: (commandName: string, skillName: string) => string;
  readonly skillMetadata?: (markdown: string) => Record<string, unknown> | undefined;
  readonly nameFromFrontmatter?: boolean | undefined;
}): ReadonlyArray<ProviderSlashCommand> {
  return mergeProviderSlashCommands(
    input.roots
      .filter((root): root is string => Boolean(root))
      .flatMap((root) =>
        readSkillRoot(root, {
          ...(input.skillPromptPrefix ? { promptPrefix: input.skillPromptPrefix } : {}),
          ...(input.skillMetadata ? { metadata: input.skillMetadata } : {}),
          ...(input.nameFromFrontmatter !== undefined
            ? { nameFromFrontmatter: input.nameFromFrontmatter }
            : {}),
        }),
      ),
  );
}

function prefixGeminiExtensionCommandConflict(
  command: ProviderSlashCommand,
  extensionName: string,
  reservedCommandNames: ReadonlySet<string>,
): ProviderSlashCommand {
  if (command.kind !== "plugin" || !reservedCommandNames.has(command.name.toLowerCase())) {
    return command;
  }
  return {
    ...command,
    name: `${extensionName}.${command.name}`,
  };
}

function readGeminiExtensionCommands(
  extensionRoot: string,
  input: {
    readonly cwd?: string | undefined;
    readonly geminiHome: string;
    readonly reservedCommandNames?: ReadonlySet<string> | undefined;
  },
): ReadonlyArray<ProviderSlashCommand> {
  const manifest = safeParseGeminiExtensionManifest(
    path.join(extensionRoot, "gemini-extension.json"),
  );
  const extensionName = normalizeCommandName(manifest?.name ?? path.basename(extensionRoot));
  if (!manifest || !extensionName) {
    return [];
  }
  if (
    !isGeminiExtensionEnabled({
      extensionName,
      cwd: input.cwd,
      geminiHome: input.geminiHome,
    })
  ) {
    return [];
  }

  const reservedCommandNames = input.reservedCommandNames ?? new Set<string>();
  return mergeProviderSlashCommands(
    readAgentMarkdownRoot(path.join(extensionRoot, "agents"), {
      nameFromFrontmatter: true,
      promptPrefix: (agentName) => `@${agentName}`,
      excludeKind: new Set(["remote"]),
      metadata: (markdown) => geminiAgentMetadata(markdown, "agent"),
    }),
    readSkillRoot(path.join(extensionRoot, "skills"), {
      promptPrefix: naturalSkillPromptPrefix,
    }),
    readGeminiExtensionTomlCommandRoot(path.join(extensionRoot, "commands")).map((command) =>
      prefixGeminiExtensionCommandConflict(command, extensionName, reservedCommandNames),
    ),
  );
}

export function discoverGeminiExtensionSlashCommands(
  input: {
    readonly cwd?: string | undefined;
    readonly home?: string | undefined;
    readonly reservedCommandNames?: ReadonlySet<string> | undefined;
  } = {},
): ReadonlyArray<ProviderSlashCommand> {
  const geminiHome = input.home?.trim() || path.join(homedir(), ".gemini");
  const extensionsRoot = path.join(geminiHome, "extensions");
  if (!isDirectory(extensionsRoot)) {
    return [];
  }
  return mergeProviderSlashCommands(
    safeReadDir(extensionsRoot).flatMap((entry) =>
      readGeminiExtensionCommands(path.join(extensionsRoot, entry), {
        cwd: input.cwd,
        geminiHome,
        reservedCommandNames: input.reservedCommandNames,
      }),
    ),
  );
}

export function discoverGeminiCustomSlashCommands(
  input: {
    readonly cwd?: string | undefined;
    readonly home?: string | undefined;
  } = {},
): ReadonlyArray<ProviderSlashCommand> {
  const geminiHome = input.home?.trim() || path.join(homedir(), ".gemini");
  const projectRoots = ancestorDirsUntilGitRoot(input.cwd);
  return mergeProviderSlashCommands(
    [
      ...projectRoots.map((root) => path.join(root, ".gemini", "agents")),
      path.join(geminiHome, "agents"),
    ].flatMap((root) => readGeminiRemoteAgentRoot(root)),
    [
      ...projectRoots.map((root) => path.join(root, ".gemini", "agents")),
      path.join(geminiHome, "agents"),
    ].flatMap((root) =>
      readAgentMarkdownRoot(root, {
        nameFromFrontmatter: true,
        requireNameFromFrontmatter: true,
        requireDescription: true,
        promptPrefix: (agentName) => `@${agentName}`,
        excludeKind: new Set(["remote"]),
        metadata: (markdown) => geminiAgentMetadata(markdown, "agent"),
      }),
    ),
    projectRoots.flatMap((root) =>
      readGeminiExtensionTomlCommandRoot(
        path.join(root, ".gemini", "commands"),
        undefined,
        undefined,
        "provider",
      ),
    ),
    readGeminiExtensionTomlCommandRoot(
      path.join(geminiHome, "commands"),
      undefined,
      undefined,
      "provider",
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
    includeRootSkillFallback: true,
    pluginPromptPrefix: naturalPluginPromptPrefix,
    skillPromptPrefix: (commandName) => `/${commandName}`,
    skillMetadata: (markdown) => claudeCommandMetadata(markdown, "skill"),
    agentPromptPrefix: (pluginName, agentName) => `@agent-${pluginName}:${agentName}`,
  });
}

export function discoverClaudeExtensionSlashCommands(
  input: ProviderExtensionInput,
): ReadonlyArray<ProviderSlashCommand> {
  const claudeHome = input.home?.trim() || path.join(homedir(), ".claude");
  const userAgentsHome = input.agentsHome?.trim() || path.join(homedir(), ".agents");
  const projectRoots = ancestorDirsUntilGitRoot(input.cwd);
  const agentCommands = mergeProviderSlashCommands(
    [
      ...projectRoots.map((root) => path.join(root, ".claude", "agents")),
      path.join(claudeHome, "agents"),
    ].flatMap((root) =>
      readAgentMarkdownRoot(root, {
        nameFromFrontmatter: true,
        promptPrefix: (agentName) => `@agent-${agentName}`,
        metadata: claudeAgentMetadata,
      }),
    ),
  );
  const skillCommands = discoverSkillRootSlashCommands({
    roots: [
      ...projectRoots.map((root) => path.join(root, ".claude", "skills")),
      ...projectRoots.map((root) => path.join(root, ".agents", "skills")),
      path.join(claudeHome, "skills"),
      path.join(userAgentsHome, "skills"),
    ],
    skillPromptPrefix: (commandName) => `/${commandName}`,
    skillMetadata: (markdown) => claudeCommandMetadata(markdown, "skill"),
    nameFromFrontmatter: false,
  });
  const nativeCommands = mergeProviderSlashCommands(
    [
      ...projectRoots.map((root) => path.join(root, ".claude", "commands")),
      path.join(claudeHome, "commands"),
    ].flatMap((root) => readClaudeMarkdownCommandRoot(root)),
  );
  const pluginCommands = readClaudeInstalledPluginEntries(claudeHome).flatMap(
    readClaudeInstalledPluginCommands,
  );

  return applyClaudeAgentSettings(
    mergeProviderSlashCommands(agentCommands, skillCommands, nativeCommands, pluginCommands),
    resolveClaudeAgentSettings({
      cwd: input.cwd,
      home: input.home,
    }),
  );
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
  const projectRoots = ancestorDirsUntilGitRoot(input.cwd);
  return mergeProviderSlashCommands(
    [
      ...projectRoots.map((root) => path.join(root, input.providerHomeDirName, "agents")),
      path.join(input.providerHome, "agents"),
    ].flatMap((root) =>
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
  const projectRoots = ancestorDirsUntilGitRoot(input.cwd);
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
            ...projectRoots.flatMap((root) => [
              path.join(root, input.providerHomeDirName, "skills"),
              path.join(root, ".agents", "skills"),
            ]),
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
  readonly claudeHome?: string | undefined;
  readonly codexHome?: string | undefined;
  readonly agentsHome?: string | undefined;
}): ReadonlyArray<ProviderSlashCommand> {
  const cursorHome = input.configDir?.trim() || path.join(homedir(), ".cursor");
  const claudeHome = input.claudeHome?.trim() || path.join(homedir(), ".claude");
  const codexHome = input.codexHome?.trim() || path.join(homedir(), ".codex");
  const userAgentsHome = input.agentsHome?.trim() || path.join(homedir(), ".agents");
  const projectRoots = ancestorDirsUntilGitRoot(input.cwd);
  const projectRoot = cursorProjectRoot(input.cwd);
  const agentCommands = mergeProviderSlashCommands(
    [
      ...projectRoots.map((root) => path.join(root, ".cursor", "agents")),
      ...projectRoots.map((root) => path.join(root, ".claude", "agents")),
      ...projectRoots.map((root) => path.join(root, ".codex", "agents")),
      path.join(cursorHome, "agents"),
      path.join(claudeHome, "agents"),
      path.join(codexHome, "agents"),
    ].flatMap((root) =>
      readAgentMarkdownRoot(root, {
        nameFromFrontmatter: true,
        promptPrefix: (agentName) => `/${agentName}`,
        metadata: cursorAgentMetadata,
      }),
    ),
  );
  const skillCommands = discoverSkillRootSlashCommands({
    roots: [
      ...projectRoots.map((root) => path.join(root, ".cursor", "skills")),
      ...projectRoots.map((root) => path.join(root, ".agents", "skills")),
      ...projectRoots.map((root) => path.join(root, ".claude", "skills")),
      ...projectRoots.map((root) => path.join(root, ".codex", "skills")),
      path.join(cursorHome, "skills"),
      path.join(userAgentsHome, "skills"),
      path.join(claudeHome, "skills"),
      path.join(codexHome, "skills"),
    ],
    skillPromptPrefix: (commandName) => `/${commandName}`,
  });
  const ruleCommands = mergeProviderSlashCommands(
    [
      ...discoverCursorProjectRuleRoots({ projectRoot, projectRoots }),
      path.join(cursorHome, "rules"),
    ].flatMap((root) => readCursorRuleRoot(root)),
  );
  const projectContextRuleCommands = readCursorProjectContextRules(projectRoot);
  const pluginCommands = pluginManifestFiles(
    path.join(cursorHome, "plugins"),
    ".cursor-plugin",
  ).flatMap((pluginJsonPath) =>
    readPluginCommands({
      pluginJsonPath,
      manifestDirName: ".cursor-plugin",
      includeMarkdownCommands: true,
      pluginPromptPrefix: naturalPluginPromptPrefix,
      skillPromptPrefix: (commandName) => `/${commandName}`,
      agentPromptPrefix: (_pluginName, agentName) => `/${agentName}`,
    }),
  );
  return mergeProviderSlashCommands(
    ...projectRoots.map((root) =>
      readCursorMarkdownCommandRoot(path.join(root, ".cursor", "commands")),
    ),
    readCursorMarkdownCommandRoot(path.join(cursorHome, "commands")),
    agentCommands,
    CURSOR_BUILT_IN_SUBAGENT_COMMANDS,
    skillCommands,
    ruleCommands,
    projectContextRuleCommands,
    pluginCommands,
  );
}

export function discoverGitHubCopilotAgentSlashCommands(input: {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
}): ReadonlyArray<ProviderSlashCommand> {
  return mergeProviderSlashCommands(
    discoverGitHubCopilotCustomAgents(input)
      .filter((agent) => agent.userInvocable !== false)
      .map((agent) =>
        providerAgentSlashCommand({
          name: agent.name,
          ...(agent.description ? { description: agent.description } : {}),
          promptPrefix: `@${agent.name}`,
          inputHint: agent.argumentHint ?? "<prompt>",
          metadata: gitHubCopilotAgentCommandMetadata(agent),
        }),
      ),
  );
}

function gitHubCopilotAgentCommandMetadata(
  agent: GitHubCopilotCustomAgent,
): Record<string, unknown> | undefined {
  const metadata = {
    provider: "github-copilot",
    source: "agent",
    ...(agent.model !== undefined ? { model: agent.model } : {}),
    ...(agent.tools ? { tools: agent.tools } : {}),
    ...(agent.agents ? { agents: agent.agents } : {}),
    ...(agent.skills ? { skills: agent.skills } : {}),
    ...(agent.handoffs ? { handoffs: agent.handoffs } : {}),
    ...(agent.mcpServers ? { mcpServers: agent.mcpServers } : {}),
    ...(agent.metadata ? { annotations: agent.metadata } : {}),
    ...(agent.infer !== undefined ? { infer: agent.infer } : {}),
    ...(agent.userInvocable !== undefined ? { userInvocable: agent.userInvocable } : {}),
    ...(agent.disableModelInvocation !== undefined
      ? { disableModelInvocation: agent.disableModelInvocation }
      : {}),
    ...(agent.target ? { target: agent.target } : {}),
  };
  return Object.keys(metadata).length > 2 ? metadata : undefined;
}

function isGitHubCopilotTarget(markdown: string): boolean {
  const target = gitHubCopilotCustomAgentTarget(markdown);
  if (!target) {
    return true;
  }
  return target.some((entry) => entry === "github-copilot" || entry === "vscode");
}

function gitHubCopilotCustomAgentTarget(markdown: string): string[] | undefined {
  const target = frontmatterStringListField(markdown, "target");
  const targetsValue =
    target ??
    frontmatterStringListField(markdown, "targets") ??
    frontmatterStringListField(markdown, "applyTo");
  if (!targetsValue) {
    return undefined;
  }
  const targets = targetsValue
    .map((entry) => entry.toLowerCase())
    .filter((entry) => entry.length > 0);
  return targets.length > 0 ? targets : undefined;
}

function normalizeGitHubCopilotMcpServers(
  value: unknown,
): GitHubCopilotCustomAgent["mcpServers"] | undefined {
  if (!value) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return mergeGitHubCopilotMcpServers(
      value.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return undefined;
        }
        const record = entry as Record<string, unknown>;
        const nested = record.mcpServers ?? record.servers;
        if (nested && typeof nested === "object" && !Array.isArray(nested)) {
          return normalizeGitHubCopilotMcpServers(nested);
        }
        const name =
          typeof record.name === "string" && record.name.trim().length > 0
            ? record.name.trim()
            : typeof record.id === "string" && record.id.trim().length > 0
              ? record.id.trim()
              : typeof record.server === "string" && record.server.trim().length > 0
                ? record.server.trim()
                : undefined;
        return name ? normalizeGitHubCopilotMcpServers({ [name]: record }) : undefined;
      }),
    );
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const servers: NonNullable<GitHubCopilotCustomAgent["mcpServers"]> = {};
  for (const [serverName, rawServer] of Object.entries(value as Record<string, unknown>)) {
    if (!rawServer || typeof rawServer !== "object" || Array.isArray(rawServer)) {
      continue;
    }
    const server = rawServer as Record<string, unknown>;
    const type = typeof server.type === "string" ? server.type : undefined;
    const tools =
      Array.isArray(server.tools) && server.tools.every((tool) => typeof tool === "string")
        ? [...server.tools]
        : ["*"];
    const timeout = typeof server.timeout === "number" ? server.timeout : undefined;
    if (type === "http" || type === "sse") {
      if (typeof server.url !== "string" || server.url.trim().length === 0) {
        continue;
      }
      servers[serverName] = {
        type,
        url: server.url,
        tools,
        ...(timeout !== undefined ? { timeout } : {}),
        ...(server.headers && typeof server.headers === "object" && !Array.isArray(server.headers)
          ? { headers: server.headers as Record<string, string> }
          : {}),
      };
      continue;
    }
    if (typeof server.command !== "string" || server.command.trim().length === 0) {
      continue;
    }
    const localType = type === "stdio" || type === "local" ? "local" : undefined;
    servers[serverName] = {
      ...(localType ? { type: localType } : {}),
      command: server.command,
      args:
        Array.isArray(server.args) && server.args.every((arg) => typeof arg === "string")
          ? [...server.args]
          : [],
      tools,
      ...(timeout !== undefined ? { timeout } : {}),
      ...(typeof server.cwd === "string" ? { cwd: server.cwd } : {}),
      ...(server.env && typeof server.env === "object" && !Array.isArray(server.env)
        ? { env: server.env as Record<string, string> }
        : {}),
    };
  }
  return Object.keys(servers).length > 0 ? servers : undefined;
}

function gitHubCopilotMcpServersFromConfig(
  config: Record<string, unknown> | null,
): GitHubCopilotCustomAgent["mcpServers"] | undefined {
  if (!config) {
    return undefined;
  }
  const value = config.mcpServers ?? config.servers;
  return value && typeof value === "object" && !Array.isArray(value)
    ? normalizeGitHubCopilotMcpServers(value as Record<string, unknown>)
    : undefined;
}

function mergeGitHubCopilotMcpServers(
  configs: ReadonlyArray<GitHubCopilotCustomAgent["mcpServers"] | undefined>,
): GitHubCopilotCustomAgent["mcpServers"] | undefined {
  const merged: NonNullable<GitHubCopilotCustomAgent["mcpServers"]> = {};
  for (const servers of configs) {
    if (!servers) {
      continue;
    }
    Object.assign(merged, servers);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function discoverGitHubCopilotMcpServers(input: {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
}): GitHubCopilotCustomAgent["mcpServers"] | undefined {
  const homeRoots = githubCopilotHomeRoots(input.home);
  const projectRoots = githubCopilotProjectRoots(input.cwd).toReversed();
  return mergeGitHubCopilotMcpServers([
    ...homeRoots.map((homeRoot) =>
      gitHubCopilotMcpServersFromConfig(
        safeParseJsoncRecord(path.join(homeRoot, "mcp-config.json")),
      ),
    ),
    ...projectRoots.flatMap((root) => [
      gitHubCopilotMcpServersFromConfig(
        safeParseJsoncRecord(path.join(root, ".vscode", "mcp.json")),
      ),
      gitHubCopilotMcpServersFromConfig(safeParseJsoncRecord(path.join(root, ".mcp.json"))),
      gitHubCopilotMcpServersFromConfig(
        safeParseJsoncRecord(path.join(root, ".github", "mcp.json")),
      ),
    ]),
  ]);
}

function gitHubCopilotCustomAgentInfer(markdown: string): boolean | undefined {
  const disableModelInvocation = gitHubCopilotCustomAgentDisableModelInvocation(markdown);
  if (disableModelInvocation !== undefined) {
    return !disableModelInvocation;
  }
  return frontmatterBooleanField(markdown, "infer");
}

function gitHubCopilotCustomAgentDisableModelInvocation(markdown: string): boolean | undefined {
  return frontmatterBooleanFieldAny(markdown, [
    "disable-model-invocation",
    "disableModelInvocation",
    "disable_model_invocation",
  ]);
}

function gitHubCopilotCustomAgentUserInvocable(markdown: string): boolean | undefined {
  return frontmatterBooleanFieldAny(markdown, [
    "user-invocable",
    "user-invokable",
    "userInvocable",
    "userInvokable",
    "user_invocable",
    "user_invokable",
  ]);
}

function normalizeGitHubCopilotCustomAgentPrompt(prompt: string): string {
  return prompt.length > GITHUB_COPILOT_CUSTOM_AGENT_PROMPT_MAX_LENGTH
    ? prompt.slice(0, GITHUB_COPILOT_CUSTOM_AGENT_PROMPT_MAX_LENGTH)
    : prompt;
}

function normalizeGitHubCopilotMetadata(
  value: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!value) {
    return undefined;
  }
  const metadata: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const normalizedKey = key.trim();
    if (!normalizedKey || typeof rawValue !== "string") {
      continue;
    }
    const normalizedValue = rawValue.trim();
    if (!normalizedValue) {
      continue;
    }
    metadata[normalizedKey] = normalizedValue;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function gitHubCopilotCustomAgentHandoffs(
  markdown: string,
): GitHubCopilotCustomAgent["handoffs"] | undefined {
  const handoffs = frontmatterObjectListField(markdown, "handoffs");
  if (!handoffs) {
    return undefined;
  }
  const normalized = handoffs
    .map((handoff) => {
      const label = typeof handoff.label === "string" ? handoff.label : undefined;
      const agent = typeof handoff.agent === "string" ? handoff.agent : undefined;
      const prompt = typeof handoff.prompt === "string" ? handoff.prompt : undefined;
      const model = typeof handoff.model === "string" ? handoff.model : undefined;
      const send = typeof handoff.send === "boolean" ? handoff.send : undefined;
      return {
        ...(label ? { label } : {}),
        ...(agent ? { agent } : {}),
        ...(prompt ? { prompt } : {}),
        ...(send !== undefined ? { send } : {}),
        ...(model ? { model } : {}),
      };
    })
    .filter(
      (handoff) =>
        handoff.label !== undefined ||
        handoff.agent !== undefined ||
        handoff.prompt !== undefined ||
        handoff.send !== undefined ||
        handoff.model !== undefined,
    );
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeHookEventName(value: string): string | null {
  const normalized = parseSimpleYamlScalar(value);
  const aliases: Record<string, string> = {
    setup: "Setup",
    pretooluse: "PreToolUse",
    permissionrequest: "PermissionRequest",
    permissiondenied: "PermissionDenied",
    posttooluse: "PostToolUse",
    posttoolusefailure: "PostToolUseFailure",
    posttoolbatch: "PostToolBatch",
    userpromptsubmit: "UserPromptSubmit",
    userpromptsubmitted: "UserPromptSubmit",
    userpromptexpansion: "UserPromptExpansion",
    sessionstart: "SessionStart",
    stop: "Stop",
    stopfailure: "StopFailure",
    sessionend: "SessionEnd",
    subagentstart: "SubagentStart",
    subagentstop: "SubagentStop",
    taskcreated: "TaskCreated",
    taskcompleted: "TaskCompleted",
    teammateidle: "TeammateIdle",
    precompact: "PreCompact",
    postcompact: "PostCompact",
    sessionended: "SessionEnd",
    worktreecreate: "WorktreeCreate",
    worktreeremove: "WorktreeRemove",
    notification: "Notification",
    configchange: "ConfigChange",
    instructionsloaded: "InstructionsLoaded",
    cwdchanged: "CwdChanged",
    filechanged: "FileChanged",
    elicitation: "Elicitation",
    elicitationresult: "ElicitationResult",
  };
  return aliases[normalized.replace(/[-_\s]/gu, "").toLowerCase()] ?? null;
}

function frontmatterHooksField(
  markdown: string,
): Record<string, ReadonlyArray<Record<string, unknown>>> | undefined {
  const block = frontmatterBlock(markdown, "hooks");
  if (!block) {
    return undefined;
  }
  const hooks: Record<string, Array<Record<string, unknown>>> = {};
  let currentEvent: string | null = null;
  let currentItem: Record<string, unknown> | null = null;
  let currentItemIndent = 0;

  const assign = (target: Record<string, unknown>, rawKey: string, rawValue: string) => {
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (!key || !value) {
      return;
    }
    target[key] = parseSimpleYamlValue(value);
  };

  for (const rawLine of block.split(/\r?\n/u)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) {
      continue;
    }
    const indent = leadingSpaceCount(rawLine);
    const line = rawLine.trim();
    const eventMatch = /^(?<event>[A-Za-z][A-Za-z0-9_-]*):\s*$/u.exec(line);
    if (eventMatch?.groups && !line.startsWith("- ")) {
      currentEvent = normalizeHookEventName(eventMatch.groups.event ?? "");
      currentItem = null;
      currentItemIndent = 0;
      if (currentEvent && !hooks[currentEvent]) {
        hooks[currentEvent] = [];
      }
      continue;
    }
    if (!currentEvent) {
      continue;
    }
    const itemMatch = /^-\s*(?<rest>.*)$/u.exec(line);
    if (itemMatch) {
      currentItem = {};
      currentItemIndent = indent;
      hooks[currentEvent]?.push(currentItem);
      const rest = itemMatch.groups?.rest?.trim();
      if (rest) {
        const fieldMatch = /^(?<key>[A-Za-z0-9_.-]+):\s*(?<value>.+)$/u.exec(rest);
        if (fieldMatch?.groups) {
          assign(currentItem, fieldMatch.groups.key ?? "", fieldMatch.groups.value ?? "");
        }
      }
      continue;
    }
    if (!currentItem || indent <= currentItemIndent) {
      continue;
    }
    const fieldMatch = /^(?<key>[A-Za-z0-9_.-]+):\s*(?<value>.+)$/u.exec(line);
    if (fieldMatch?.groups) {
      assign(currentItem, fieldMatch.groups.key ?? "", fieldMatch.groups.value ?? "");
    }
  }

  for (const [eventName, commands] of Object.entries(hooks)) {
    hooks[eventName] = commands.filter((command) => Object.keys(command).length > 0);
    if ((hooks[eventName]?.length ?? 0) === 0) {
      delete hooks[eventName];
    }
  }
  return Object.keys(hooks).length > 0 ? hooks : undefined;
}

function readGitHubCopilotCustomAgent(
  file: string,
  options: { readonly includeHooks: boolean },
): GitHubCopilotCustomAgent | null {
  if (!file.endsWith(".md")) {
    return null;
  }
  const markdown = safeReadFile(file);
  if (!markdown) {
    return null;
  }
  if (!isGitHubCopilotTarget(markdown)) {
    return null;
  }
  const name = normalizeCommandName(stripGitHubCopilotAgentSuffix(path.basename(file, ".md")));
  const prompt = normalizeGitHubCopilotCustomAgentPrompt(markdownBodyWithoutFrontmatter(markdown));
  if (!name || !prompt) {
    return null;
  }
  const displayName = frontmatterField(markdown, "name");
  const description = frontmatterField(markdown, "description");
  if (!description) {
    return null;
  }
  const argumentHint = frontmatterFieldAny(markdown, [
    "argument-hint",
    "argumentHint",
    "argument_hint",
  ]);
  const tools = frontmatterStringListField(markdown, "tools");
  const agents = frontmatterStringListField(markdown, "agents");
  const infer = gitHubCopilotCustomAgentInfer(markdown);
  const userInvocable = gitHubCopilotCustomAgentUserInvocable(markdown);
  const disableModelInvocation = gitHubCopilotCustomAgentDisableModelInvocation(markdown);
  const model = frontmatterStringOrListField(markdown, "model");
  const target = gitHubCopilotCustomAgentTarget(markdown);
  const metadata = normalizeGitHubCopilotMetadata(
    frontmatterJsonObjectField(markdown, "metadata") ??
      frontmatterYamlObjectField(markdown, "metadata"),
  );
  const handoffs = gitHubCopilotCustomAgentHandoffs(markdown);
  const hooks = options.includeHooks ? frontmatterHooksField(markdown) : undefined;
  const mcpServers = normalizeGitHubCopilotMcpServers(
    frontmatterJsonValueField(markdown, "mcp-servers") ??
      frontmatterJsonValueField(markdown, "mcpServers") ??
      frontmatterJsonObjectField(markdown, "mcp-servers") ??
      frontmatterJsonObjectField(markdown, "mcpServers") ??
      frontmatterYamlObjectField(markdown, "mcp-servers") ??
      frontmatterYamlObjectField(markdown, "mcpServers"),
  );
  const skills = frontmatterStringListField(markdown, "skills");
  return {
    name,
    prompt,
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    ...(argumentHint ? { argumentHint } : {}),
    ...(tools ? { tools } : {}),
    ...(agents ? { agents } : {}),
    ...(infer !== undefined ? { infer } : {}),
    ...(userInvocable !== undefined ? { userInvocable } : {}),
    ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}),
    ...(target ? { target } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(metadata ? { metadata } : {}),
    ...(handoffs ? { handoffs } : {}),
    ...(hooks ? { hooks } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(skills ? { skills } : {}),
  };
}

function readGitHubCopilotCustomAgentRoot(
  root: string,
  options: { readonly includeHooks: boolean },
  depth = 0,
): GitHubCopilotCustomAgent[] {
  if (!isDirectory(root)) {
    return [];
  }
  const agents: GitHubCopilotCustomAgent[] = [];
  for (const entry of safeReadDir(root)) {
    const entryPath = path.join(root, entry);
    const agent = readGitHubCopilotCustomAgent(entryPath, options);
    if (agent) {
      agents.push(agent);
    } else if (depth < 4 && isDirectory(entryPath)) {
      agents.push(...readGitHubCopilotCustomAgentRoot(entryPath, options, depth + 1));
    }
  }
  return agents;
}

export function discoverGitHubCopilotCustomAgents(input: {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
  readonly includeChatModes?: boolean | undefined;
}): ReadonlyArray<GitHubCopilotCustomAgent> {
  const roots = githubCopilotAgentRoots(input);
  const includeHooks = githubCopilotCustomAgentHooksEnabled(input.cwd);
  const agents: GitHubCopilotCustomAgent[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const agent of readGitHubCopilotCustomAgentRoot(root, { includeHooks })) {
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
  if (!githubCopilotAgentSkillsEnabled(input.cwd)) {
    return [];
  }
  const providerHomes = githubCopilotHomeRoots(input.home);
  const userAgentsHome = input.agentsHome?.trim() || path.join(homedir(), ".agents");
  const projectRoots = githubCopilotProjectRoots(input.cwd);
  return uniquePaths([
    ...projectRoots.flatMap((root) => [
      path.join(root, ".github", "skills"),
      path.join(root, ".claude", "skills"),
      path.join(root, ".github-copilot", "skills"),
      path.join(root, ".agents", "skills"),
      ...githubCopilotConfiguredSkillRoots(root),
    ]),
    ...providerHomes.map((providerHome) => path.join(providerHome, "skills")),
    path.join(userAgentsHome, "skills"),
  ]).filter((root) => isDirectory(root));
}

export function discoverGitHubCopilotPromptSlashCommands(input: {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
}): ReadonlyArray<ProviderSlashCommand> {
  return mergeProviderSlashCommands(
    githubCopilotPromptRoots(input).flatMap(readGitHubCopilotPromptRoot),
  );
}

export function discoverGitHubCopilotInstructionSlashCommands(input: {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
}): ReadonlyArray<ProviderSlashCommand> {
  const homeRoots = githubCopilotHomeRoots(input.home);
  const projectRoots = githubCopilotProjectRoots(input.cwd);
  const repositoryRoot = gitHubCopilotRepositoryRoot(input.cwd);
  return mergeProviderSlashCommands(
    githubCopilotInstructionFiles(input)
      .map((file) => readGitHubCopilotInstructionCommand({ file, repositoryRoot }))
      .filter((command): command is ProviderSlashCommand => command !== null),
    projectRoots.flatMap((root) =>
      [
        path.join(root, ".github", "instructions"),
        path.join(root, ".claude", "rules"),
        ...githubCopilotConfiguredInstructionRoots(root),
      ].flatMap((instructionRoot) =>
        readGitHubCopilotInstructionRoot({
          root: instructionRoot,
          repositoryRoot,
        }),
      ),
    ),
    homeRoots.flatMap((homeRoot) =>
      readGitHubCopilotInstructionRoot({
        root: path.join(homeRoot, "instructions"),
      }),
    ),
  );
}

export function discoverOpenCodeAgentSlashCommands(input: {
  readonly cwd?: string | undefined;
  readonly home?: string | undefined;
}): ReadonlyArray<ProviderSlashCommand> {
  const providerHome = input.home?.trim() || path.join(homedir(), ".config", "opencode");
  const projectRoots = ancestorDirsUntilGitRoot(input.cwd);
  const configFiles = [
    ...projectRoots.flatMap((root) => [
      path.join(root, "opencode.json"),
      path.join(root, "opencode.jsonc"),
    ]),
    path.join(providerHome, "opencode.json"),
    path.join(providerHome, "opencode.jsonc"),
  ];
  const markdownAgentRoots = [
    ...projectRoots.flatMap((root) => [
      path.join(root, ".opencode", "agents"),
      path.join(root, ".opencode", "agent"),
    ]),
    path.join(providerHome, "agents"),
    path.join(providerHome, "agent"),
  ];
  const markdownAgentCommands = mergeProviderSlashCommands(
    markdownAgentRoots.flatMap((root) =>
      readAgentMarkdownRoot(root, {
        includeMode: new Set(["subagent", "all"]),
        includeMissingMode: true,
        excludeDisabled: true,
        requireDescription: true,
        metadata: openCodeAgentMetadataFromMarkdown,
      }),
    ),
  );
  const subagentNames = mergeOpenCodeSubagentNames(
    ...configFiles.map(readOpenCodeJsonSubagentNames),
    ...markdownAgentRoots.map(readOpenCodeMarkdownSubagentNames),
    new Set(markdownAgentCommands.map((command) => command.name)),
  );
  return mergeProviderSlashCommands(
    [
      ...projectRoots.map((root) => path.join(root, ".opencode", "commands")),
      ...projectRoots.map((root) => path.join(root, ".opencode", "command")),
      path.join(providerHome, "commands"),
      path.join(providerHome, "command"),
    ].flatMap((root) => readOpenCodeMarkdownCommandRoot(root, subagentNames)),
    configFiles.flatMap((file) => readOpenCodeJsonConfigCommands(file, subagentNames)),
    markdownAgentCommands,
    configFiles.flatMap(readOpenCodeJsonAgentCommands),
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
  const piAgentRoots = uniquePaths([
    ...ancestorDirs.flatMap((dir) => [path.join(dir, ".pi", "agents"), path.join(dir, ".agents")]),
    path.join(piAgentDir, "agents"),
    path.join(piAgentDir, "extensions", "subagent", "agents"),
  ]);
  const promptRoots = uniquePaths([
    ...ancestorDirs.map((dir) => path.join(dir, ".pi", "prompts")),
    path.join(piAgentDir, "prompts"),
  ]);
  const packageRoots = uniquePaths(ancestorDirs);
  const settingsFiles = uniquePaths([
    ...ancestorDirs.map((dir) => path.join(dir, ".pi", "settings.json")),
    path.join(piAgentDir, "settings.json"),
  ]);

  return applyPiSettings(
    mergeProviderSlashCommands(
      piSpecificRoots.flatMap((root) =>
        readPiSkillRoot({
          root,
          includeRootMarkdownFiles: true,
        }),
      ),
      piAgentRoots.flatMap(readPiAgentResource),
      sharedAgentRoots.flatMap((root) =>
        readPiSkillRoot({
          root,
        }),
      ),
      promptRoots.flatMap(readPiPromptTemplateRoot),
      packageRoots.flatMap((packageRoot) => readPiPackageCommands(packageRoot)),
      settingsFiles.flatMap((settingsFile) =>
        readPiSettingsCommands({
          settingsFile,
          baseDir:
            settingsFile === path.join(piAgentDir, "settings.json")
              ? piAgentDir
              : path.dirname(settingsFile),
        }),
      ),
      filterPiBuiltinSubagentCommands(settingsFiles),
      discoverGenericProviderExtensionSlashCommands({
        cwd: input.cwd,
        home: piAgentDir,
        providerHomeDirName: ".pi",
        pluginManifestDirName: ".pi-plugin",
        includeAgentCommands: false,
        includeSkillCommands: false,
      }),
    ),
    settingsFiles,
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
      return applyClaudeAgentSettings(
        mergeProviderSlashCommands(
          discoverClaudeExtensionSlashCommands({
            cwd: input.cwd,
            home: input.settings.providers.claudeAgent.configDir,
          }),
          CLAUDE_BUILT_IN_SUBAGENT_COMMANDS,
        ),
        resolveClaudeAgentSettings({
          cwd: input.cwd,
          home: input.settings.providers.claudeAgent.configDir,
        }),
      );
    case "cursor":
      return discoverCursorExtensionSlashCommands({
        cwd: input.cwd,
        configDir: input.settings.providers.cursor.configDir,
        claudeHome: input.settings.providers.claudeAgent.configDir,
        codexHome: input.settings.providers.codex.homePath,
      });
    case "gemini": {
      const agentSettings = resolveGeminiAgentSettings({
        cwd: input.cwd,
        home: input.settings.providers.gemini.configDir,
      });
      const genericCommands = discoverGenericProviderExtensionSlashCommands({
        cwd: input.cwd,
        home: input.settings.providers.gemini.configDir,
        providerHomeDirName: ".gemini",
        includeAgentCommands: false,
      });
      const customCommands = discoverGeminiCustomSlashCommands({
        cwd: input.cwd,
        home: input.settings.providers.gemini.configDir,
      });
      const builtInAgentCommands = geminiBuiltInSubagentCommandsForSettings(agentSettings);
      const extensionReservedCommandNames = new Set(
        mergeProviderSlashCommands(genericCommands, customCommands, builtInAgentCommands).map(
          (command) => command.name.toLowerCase(),
        ),
      );
      return applyGeminiAgentSettings(
        mergeProviderSlashCommands(
          genericCommands,
          customCommands,
          discoverGeminiExtensionSlashCommands({
            cwd: input.cwd,
            home: input.settings.providers.gemini.configDir,
            reservedCommandNames: extensionReservedCommandNames,
          }),
          builtInAgentCommands,
        ),
        agentSettings,
      );
    }
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
        GITHUB_COPILOT_BUILT_IN_AGENT_COMMANDS,
        discoverGitHubCopilotPromptSlashCommands({
          cwd: input.cwd,
          home: input.settings.providers.githubCopilot.homePath,
        }),
        discoverGitHubCopilotInstructionSlashCommands({
          cwd: input.cwd,
          home: input.settings.providers.githubCopilot.homePath,
        }),
        discoverSkillRootSlashCommands({
          roots: discoverGitHubCopilotSkillDirectories({
            cwd: input.cwd,
            home: input.settings.providers.githubCopilot.homePath,
          }),
          skillPromptPrefix: (commandName) => `/${commandName}`,
          skillMetadata: gitHubCopilotSkillMetadata,
        }),
        discoverGitHubCopilotPluginSlashCommands({
          home: input.settings.providers.githubCopilot.homePath,
        }),
        discoverGenericProviderExtensionSlashCommands({
          cwd: input.cwd,
          home: input.settings.providers.githubCopilot.homePath,
          providerHomeDirName: ".github-copilot",
          includeAgentCommands: false,
        }),
      );
    case "opencode":
      return mergeProviderSlashCommands(
        discoverOpenCodeAgentSlashCommands({
          cwd: input.cwd,
          home: input.settings.providers.opencode.configDir,
        }),
        OPENCODE_BUILT_IN_SUBAGENT_COMMANDS,
        discoverGenericProviderExtensionSlashCommands({
          cwd: input.cwd,
          home: input.settings.providers.opencode.configDir,
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
