import type { ProviderKind, ProviderSlashCommand } from "@ace/contracts";

export type ProviderExtensionCommandKind = "skill" | "plugin";

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

function normalizeProviderCommandKind(value: unknown): ProviderExtensionCommandKind | null {
  return value === "skill" || value === "plugin" ? value : null;
}

function normalizeProviderSlashCommandKind(value: unknown): ProviderSlashCommandKind | null {
  return value === "provider" || value === "skill" || value === "plugin" ? value : null;
}

export function normalizeProviderSlashCommandName(value: string): string | null {
  const name = value.trim().replace(/^[/@$]+/, "");
  if (!name || /\s/.test(name)) {
    return null;
  }
  return name;
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
    return "plugin";
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
        (kind === "skill" ? `$${name}` : kind === "plugin" ? `@${name}` : undefined);

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

function providerCommand(
  name: string,
  description: string,
  inputHint?: string,
): ProviderSlashCommand {
  return {
    name,
    kind: "provider",
    description,
    ...(inputHint ? { inputHint } : {}),
  };
}

const CODEX_SLASH_COMMANDS = [
  providerCommand("permissions", "Set what Codex can do without asking first"),
  providerCommand(
    "sandbox-add-read-dir",
    "Grant sandbox read access to an extra directory",
    "<path>",
  ),
  providerCommand("agent", "Switch the active agent thread"),
  providerCommand("apps", "Browse apps and insert them into your prompt"),
  providerCommand("plugins", "Browse installed and discoverable plugins"),
  providerCommand("clear", "Clear the terminal and start a fresh chat"),
  providerCommand("compact", "Summarize the visible conversation to free tokens"),
  providerCommand("copy", "Copy the latest completed Codex output"),
  providerCommand("diff", "Show the Git diff"),
  providerCommand("exit", "Exit the CLI"),
  providerCommand("experimental", "Toggle experimental features"),
  providerCommand("feedback", "Send logs to Codex maintainers"),
  providerCommand("init", "Generate an AGENTS.md scaffold"),
  providerCommand("logout", "Sign out of Codex"),
  providerCommand("mcp", "List configured MCP tools", "verbose"),
  providerCommand("mention", "Attach a file to the conversation", "<path>"),
  providerCommand("model", "Choose the active model"),
  providerCommand("fast", "Toggle Fast mode", "on|off|status"),
  providerCommand("plan", "Switch to plan mode and optionally send a prompt", "<prompt>"),
  providerCommand("personality", "Choose a response communication style"),
  providerCommand("ps", "Show background terminals and recent output"),
  providerCommand("stop", "Stop background terminals"),
  providerCommand("fork", "Fork the current conversation"),
  providerCommand("side", "Start an ephemeral side conversation", "<prompt>"),
  providerCommand("resume", "Resume a saved conversation"),
  providerCommand("new", "Start a new conversation"),
  providerCommand("quit", "Exit the CLI"),
  providerCommand("review", "Ask Codex to review your working tree"),
  providerCommand("status", "Display session configuration and token usage"),
  providerCommand("debug-config", "Print config layer and requirement diagnostics"),
  providerCommand("statusline", "Configure TUI status-line fields"),
  providerCommand("title", "Configure terminal title fields"),
  providerCommand("keymap", "Remap TUI keyboard shortcuts"),
] as const satisfies ReadonlyArray<ProviderSlashCommand>;

const CLAUDE_SLASH_COMMANDS = [
  providerCommand("help", "Show Claude Code help"),
  providerCommand("init", "Initialize project memory"),
  providerCommand("mcp", "Manage MCP servers"),
  providerCommand("model", "Switch model"),
  providerCommand("permissions", "Review or change permission mode"),
  providerCommand("agents", "Manage agents"),
  providerCommand("plugin", "Manage plugins"),
  providerCommand("resume", "Resume a conversation"),
  providerCommand("compact", "Compact conversation context"),
  providerCommand("clear", "Clear conversation state"),
  providerCommand("memory", "Manage loaded memory"),
  providerCommand("login", "Log in"),
  providerCommand("logout", "Log out"),
  providerCommand("doctor", "Check CLI health"),
  providerCommand("review", "Run a code review"),
] as const satisfies ReadonlyArray<ProviderSlashCommand>;

const GITHUB_COPILOT_SLASH_COMMANDS = [
  providerCommand("init", "Initialize Copilot instructions"),
  providerCommand("agent", "Browse and select available agents"),
  providerCommand("skills", "Manage skills"),
  providerCommand("mcp", "Manage MCP server configuration"),
  providerCommand("plugin", "Manage plugins and marketplaces"),
  providerCommand("model", "Select AI model"),
  providerCommand("delegate", "Send this session to GitHub to create a PR"),
  providerCommand("fleet", "Enable fleet mode"),
  providerCommand("tasks", "View and manage background tasks"),
  providerCommand("ide", "Connect to an IDE workspace"),
  providerCommand("diff", "Review current directory changes"),
  providerCommand("pr", "Operate on pull requests"),
  providerCommand("review", "Run code review"),
  providerCommand("lsp", "Manage language server configuration"),
  providerCommand("terminal-setup", "Configure multiline terminal input"),
  providerCommand("allow-all", "Enable all permissions"),
  providerCommand("add-dir", "Add an allowed file access directory", "<path>"),
  providerCommand("list-dirs", "Display allowed file access directories"),
  providerCommand("cwd", "Change or show current directory", "<path>"),
  providerCommand("reset-allowed-tools", "Reset allowed tools"),
  providerCommand("resume", "Switch to a different session", "<session>"),
  providerCommand("rename", "Rename the current session"),
  providerCommand("context", "Show context window usage"),
  providerCommand("usage", "Display session usage metrics"),
  providerCommand("session", "View and manage sessions"),
  providerCommand("compact", "Summarize conversation history"),
  providerCommand("share", "Share the session"),
  providerCommand("remote", "Show or toggle remote control"),
  providerCommand("copy", "Copy the last response"),
  providerCommand("rewind", "Rewind the last turn"),
  providerCommand("help", "Show help for interactive commands"),
  providerCommand("changelog", "Display CLI changelog"),
  providerCommand("feedback", "Provide CLI feedback"),
  providerCommand("theme", "View or set color mode"),
  providerCommand("statusline", "Configure status line items"),
  providerCommand("footer", "Configure status line items"),
  providerCommand("update", "Update the CLI"),
  providerCommand("version", "Display version information"),
  providerCommand("experimental", "Show or toggle experimental features"),
  providerCommand("clear", "Abandon this session and start fresh"),
  providerCommand("instructions", "View and toggle instruction files"),
  providerCommand("streamer-mode", "Toggle streamer mode"),
  providerCommand("ask", "Ask a side question without changing history", "<prompt>"),
  providerCommand("env", "Show loaded environment details"),
  providerCommand("exit", "Exit the CLI"),
  providerCommand("keep-alive", "Manage keep-alive mode"),
  providerCommand("login", "Log in to Copilot"),
  providerCommand("logout", "Log out"),
  providerCommand("new", "Start a new conversation"),
  providerCommand("plan", "Create an implementation plan", "<prompt>"),
  providerCommand("research", "Run a deep research investigation", "<prompt>"),
  providerCommand("restart", "Restart the CLI"),
  providerCommand("search", "Search the conversation timeline", "<query>"),
  providerCommand("sidekicks", "View running sidekick agents"),
  providerCommand("undo", "Rewind the last turn"),
  providerCommand("user", "Manage GitHub user list"),
] as const satisfies ReadonlyArray<ProviderSlashCommand>;

const CURSOR_SLASH_COMMANDS = [
  providerCommand("help", "Show Cursor Agent help"),
  providerCommand("model", "Switch model"),
  providerCommand("plan", "Switch to plan mode", "<prompt>"),
  providerCommand("ask", "Switch to ask mode", "<prompt>"),
  providerCommand("diff", "Review current changes"),
  providerCommand("new", "Start a new chat"),
  providerCommand("resume", "Resume a chat"),
  providerCommand("mcp", "Manage MCP servers"),
  providerCommand("status", "Show authentication status"),
  providerCommand("login", "Log in to Cursor"),
  providerCommand("logout", "Log out"),
  providerCommand("about", "Display version and account information"),
  providerCommand("generate-rule", "Generate a Cursor rule"),
] as const satisfies ReadonlyArray<ProviderSlashCommand>;

const GEMINI_SLASH_COMMANDS = [
  providerCommand("about", "Show version information"),
  providerCommand("agents", "Manage local and remote subagents"),
  providerCommand("auth", "Change authentication method"),
  providerCommand("bug", "File a Gemini CLI issue", "<title>"),
  providerCommand("chat", "Browse or manage saved chats"),
  providerCommand("clear", "Clear the terminal screen"),
  providerCommand("commands", "Manage custom slash commands"),
  providerCommand("compress", "Replace chat context with a summary"),
  providerCommand("copy", "Copy the last output"),
  providerCommand("directory", "Manage workspace directories"),
  providerCommand("dir", "Manage workspace directories"),
  providerCommand("docs", "Open Gemini CLI documentation"),
  providerCommand("editor", "Select supported editors"),
  providerCommand("extensions", "Manage extensions"),
  providerCommand("help", "Display Gemini CLI help"),
  providerCommand("?", "Display Gemini CLI help"),
  providerCommand("hooks", "Manage hooks"),
  providerCommand("ide", "Manage IDE integration"),
  providerCommand("init", "Generate a GEMINI.md context file"),
  providerCommand("mcp", "Manage MCP servers"),
  providerCommand("memory", "Manage loaded GEMINI.md memory"),
  providerCommand("model", "Manage model configuration"),
  providerCommand("permissions", "Manage folder trust and permissions"),
  providerCommand("plan", "Switch to Plan Mode"),
  providerCommand("policies", "Manage policies"),
  providerCommand("privacy", "Display privacy notice"),
  providerCommand("quit", "Exit Gemini CLI"),
  providerCommand("exit", "Exit Gemini CLI"),
  providerCommand("restore", "Restore project files before a tool call", "<tool_call_id>"),
  providerCommand("rewind", "Navigate backward through conversation history"),
  providerCommand("resume", "Browse and resume sessions"),
  providerCommand("settings", "Open the settings editor"),
  providerCommand("shells", "Toggle background shells view"),
  providerCommand("bashes", "Toggle background shells view"),
  providerCommand("setup-github", "Set up GitHub Actions for Gemini"),
  providerCommand("skills", "Manage Agent Skills"),
  providerCommand("stats", "Display session statistics"),
  providerCommand("terminal-setup", "Configure multiline terminal input"),
  providerCommand("theme", "Change visual theme"),
  providerCommand("tools", "Display available tools"),
  providerCommand("upgrade", "Open Gemini Code Assist upgrade page"),
  providerCommand("vim", "Toggle vim mode"),
] as const satisfies ReadonlyArray<ProviderSlashCommand>;

const OPENCODE_SLASH_COMMANDS = [
  providerCommand("help", "Show OpenCode help"),
  providerCommand("init", "Initialize project instructions"),
  providerCommand("model", "Switch model"),
  providerCommand("agent", "Switch agent"),
  providerCommand("new", "Start a new session"),
  providerCommand("session", "Manage sessions"),
  providerCommand("compact", "Summarize conversation context"),
  providerCommand("share", "Share the session"),
  providerCommand("diff", "Show session diff"),
  providerCommand("undo", "Revert the last change"),
  providerCommand("redo", "Restore a reverted change"),
  providerCommand("theme", "Change theme"),
  providerCommand("mcp", "Manage MCP servers"),
  providerCommand("login", "Configure provider authentication"),
  providerCommand("logout", "Clear provider authentication"),
] as const satisfies ReadonlyArray<ProviderSlashCommand>;

const FALLBACK_COMMANDS_BY_PROVIDER: Record<ProviderKind, ReadonlyArray<ProviderSlashCommand>> = {
  codex: CODEX_SLASH_COMMANDS,
  claudeAgent: CLAUDE_SLASH_COMMANDS,
  githubCopilot: GITHUB_COPILOT_SLASH_COMMANDS,
  cursor: CURSOR_SLASH_COMMANDS,
  gemini: GEMINI_SLASH_COMMANDS,
  opencode: OPENCODE_SLASH_COMMANDS,
};

export function providerFallbackSlashCommands(
  provider: ProviderKind | null | undefined,
): ReadonlyArray<ProviderSlashCommand> {
  return provider ? FALLBACK_COMMANDS_BY_PROVIDER[provider] : [];
}
