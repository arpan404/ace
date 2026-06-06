import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ProviderSlashCommand } from "@ace/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@ace/contracts/settings";
import { describe, expect, it } from "vitest";

import {
  discoverClaudeAgentConfigOption,
  discoverClaudeForkSubagentsConfigOption,
  discoverClaudeSdkAgentSlashCommands,
  discoverClaudeOutputStyleConfigOption,
  discoverClaudeSubagentModelConfigOption,
  discoverClaudeExtensionSlashCommands,
  discoverCodexExtensionSlashCommands,
  discoverCursorExtensionSlashCommands,
  discoverGeminiCustomSlashCommands,
  discoverGenericProviderExtensionSlashCommands,
  geminiBuiltInSubagentCommands,
  discoverGeminiExtensionSlashCommands,
  discoverGitHubCopilotAgentSlashCommands,
  discoverGitHubCopilotAgentConfigOption,
  discoverGitHubCopilotCustomAgents,
  discoverGitHubCopilotMcpServers,
  discoverGitHubCopilotInstructionSlashCommands,
  discoverGitHubCopilotPluginSlashCommands,
  discoverGitHubCopilotPromptSlashCommands,
  discoverGitHubCopilotSkillDirectories,
  discoverOpenCodeAgentSlashCommands,
  discoverPiExtensionSlashCommands,
  withProviderExtensionSlashCommands,
} from "./providerExtensionSlashCommands.ts";

async function writeSkill(
  root: string,
  name: string,
  description: string,
  frontmatter: ReadonlyArray<string> = [],
): Promise<void> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n${frontmatter.join("\n")}${
      frontmatter.length > 0 ? "\n" : ""
    }---\n\n# ${name}\n`,
  );
}

async function writeMarkdownSkill(
  root: string,
  fileName: string,
  name: string,
  description?: string | undefined,
  frontmatter: ReadonlyArray<string> = [],
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, fileName),
    [
      "---",
      `name: ${name}`,
      ...(description ? [`description: ${description}`] : []),
      ...frontmatter,
      "---",
      "",
      "# Markdown skill",
    ].join("\n"),
  );
}

async function writePiPrompt(root: string, fileName: string, body: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, fileName), body);
}

async function writeCursorCommand(root: string, fileName: string, body: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, fileName), body);
}

async function writeAgentMarkdown(input: {
  readonly root: string;
  readonly fileName: string;
  readonly name?: string | undefined;
  readonly description: string;
  readonly mode?: string | undefined;
  readonly model?: string | undefined;
  readonly tools?: ReadonlyArray<string> | undefined;
  readonly allowedTools?: ReadonlyArray<string> | undefined;
  readonly temperature?: number | undefined;
  readonly maxSteps?: number | undefined;
  readonly permission?: Record<string, string | Record<string, string>> | undefined;
  readonly taskPermission?: Record<string, string> | undefined;
  readonly color?: string | undefined;
  readonly disable?: boolean | undefined;
  readonly disabled?: boolean | undefined;
}): Promise<void> {
  await mkdir(input.root, { recursive: true });
  await writeFile(
    path.join(input.root, input.fileName),
    [
      "---",
      ...(input.name ? [`name: ${input.name}`] : []),
      `description: ${input.description}`,
      ...(input.mode ? [`mode: ${input.mode}`] : []),
      ...(input.model ? [`model: ${input.model}`] : []),
      ...(input.tools ? [`tools: [${input.tools.join(", ")}]`] : []),
      ...(input.allowedTools ? [`allowed-tools: [${input.allowedTools.join(", ")}]`] : []),
      ...(input.temperature !== undefined ? [`temperature: ${input.temperature}`] : []),
      ...(input.maxSteps !== undefined ? [`maxSteps: ${input.maxSteps}`] : []),
      ...(input.permission || input.taskPermission
        ? [
            "permission:",
            ...Object.entries(input.permission ?? {}).flatMap(([key, value]) =>
              typeof value === "string"
                ? [`  ${key}: ${value}`]
                : [
                    `  ${key}:`,
                    ...Object.entries(value).map(
                      ([pattern, action]) => `    "${pattern}": ${action}`,
                    ),
                  ],
            ),
            ...(input.taskPermission ? ["  task:"] : []),
            ...(input.taskPermission
              ? Object.entries(input.taskPermission).map(
                  ([pattern, action]) => `    "${pattern}": ${action}`,
                )
              : []),
          ]
        : []),
      ...(input.color ? [`color: ${input.color}`] : []),
      ...(input.disable !== undefined ? [`disable: ${input.disable ? "true" : "false"}`] : []),
      ...(input.disabled !== undefined ? [`disabled: ${input.disabled ? "true" : "false"}`] : []),
      "---",
      "",
      "# Agent prompt",
    ].join("\n"),
  );
}

async function writeOutputStyle(
  root: string,
  fileName: string,
  name: string,
  description: string,
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, fileName),
    [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "keep-coding-instructions: true",
      "---",
      "",
      "Use this response style.",
    ].join("\n"),
  );
}

function findCommand(
  commands: ReadonlyArray<ProviderSlashCommand>,
  name: string,
): ProviderSlashCommand | undefined {
  return commands.find((command) => command.name === name);
}

describe("providerExtensionSlashCommands", () => {
  it("discovers Claude output styles from project, user, and installed plugins", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ace-claude-output-styles-"));
    const repo = path.join(root, "repo");
    const cwd = path.join(repo, "packages", "web");
    const claudeHome = path.join(root, ".claude");
    const pluginRoot = path.join(root, "plugins", "style-pack");
    try {
      await mkdir(path.join(repo, ".git"), { recursive: true });
      await mkdir(cwd, { recursive: true });
      await writeOutputStyle(
        path.join(repo, ".claude", "output-styles"),
        "diagrams.md",
        "Diagrams first",
        "Lead with diagrams",
      );
      await writeOutputStyle(
        path.join(claudeHome, "output-styles"),
        "concise.md",
        "Concise",
        "Keep responses concise",
      );
      await mkdir(path.join(claudeHome, "plugins"), { recursive: true });
      await writeFile(
        path.join(claudeHome, "plugins", "installed_plugins.json"),
        JSON.stringify({
          plugins: {
            "style-pack@local": [{ installPath: pluginRoot }],
          },
        }),
      );
      await writeOutputStyle(
        path.join(pluginRoot, "output-styles"),
        "review.md",
        "Review mode",
        "Review changes carefully",
      );

      const option = discoverClaudeOutputStyleConfigOption({
        cwd,
        home: claudeHome,
        selectedOutputStyle: "Review mode",
      });

      expect(option).toEqual(
        expect.objectContaining({
          id: "output_style",
          name: "Style",
          category: "output_style",
          type: "select",
          currentValue: "Review mode",
        }),
      );
      expect(option.options).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: "Default", name: "Default" }),
          expect.objectContaining({ value: "Explanatory", name: "Explanatory" }),
          expect.objectContaining({ value: "Learning", name: "Learning" }),
          expect.objectContaining({ value: "Diagrams first", name: "Diagrams first" }),
          expect.objectContaining({ value: "Concise", name: "Concise" }),
          expect.objectContaining({ value: "Review mode", name: "Review mode" }),
        ]),
      );
      expect(option.options.some((entry) => entry.value === "Proactive")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers Claude session agents from available subagents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ace-claude-agent-config-"));
    const repo = path.join(root, "repo");
    const cwd = path.join(repo, "packages", "web");
    const claudeHome = path.join(root, ".claude");
    try {
      await mkdir(path.join(repo, ".git"), { recursive: true });
      await mkdir(cwd, { recursive: true });
      await mkdir(path.join(repo, ".claude"), { recursive: true });
      await writeFile(
        path.join(repo, ".claude", "settings.json"),
        JSON.stringify({ agent: "reviewer" }),
      );
      await writeAgentMarkdown({
        root: path.join(repo, ".claude", "agents"),
        fileName: "reviewer.md",
        name: "reviewer",
        description: "Review implementation details",
        model: "sonnet",
        tools: ["Read", "Grep"],
      });
      await writeAgentMarkdown({
        root: path.join(claudeHome, "agents"),
        fileName: "docs-writer.md",
        name: "docs-writer",
        description: "Draft documentation",
        allowedTools: ["Read"],
      });
      await writeFile(
        path.join(repo, ".claude", "agents", "safe-researcher.md"),
        [
          "---",
          "name: safe-researcher",
          "description: Research agent with a constrained Claude Code profile",
          "tools: Read, Grep, Glob, Bash",
          "disallowedTools: Write, Edit",
          "model: claude-haiku-4-5",
          "permissionMode: plan",
          "mcpServers:",
          "  docs:",
          "    command: docs-mcp",
          "    args:",
          "      - --stdio",
          'hooks: {"SessionStart":[{"type":"command","command":"./scripts/agent-start.sh"}]}',
          "maxTurns: 8",
          "skills: [repo-map, dependency-docs]",
          "initialPrompt: Summarize the current implementation context before researching.",
          "effort: high",
          "background: true",
          "isolation: worktree",
          "color: teal",
          "memory:",
          "  retain: project-map",
          "---",
          "",
          "Research safely without editing files.",
        ].join("\n"),
      );
      await writeFile(
        path.join(repo, ".claude", "agents", "snake-case-reviewer.md"),
        [
          "---",
          "name: snake-case-reviewer",
          "description: Review code with snake-case Claude agent metadata",
          "allowed_tools: [Read, Grep]",
          "disallowed_tools: [Write, Edit]",
          "permission_mode: acceptEdits",
          "mcp_servers:",
          "  repo:",
          "    command: repo-mcp",
          "max_turns: 5",
          "initial_prompt: Start by summarizing the files you will inspect.",
          "is_background: true",
          "---",
          "",
          "Review safely with snake-case fields.",
        ].join("\n"),
      );

      const commands = discoverClaudeExtensionSlashCommands({ cwd, home: claudeHome });
      const option = discoverClaudeAgentConfigOption({
        cwd,
        home: claudeHome,
        commands,
      });

      expect(option).toEqual(
        expect.objectContaining({
          id: "agent",
          name: "Agent",
          category: "agent",
          type: "select",
          currentValue: "reviewer",
        }),
      );
      expect(option.options).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: "default", name: "Default" }),
          expect.objectContaining({
            value: "reviewer",
            name: "reviewer",
            description: "Review implementation details",
          }),
          expect.objectContaining({
            value: "docs-writer",
            name: "docs-writer",
            description: "Draft documentation",
          }),
          expect.objectContaining({
            value: "safe-researcher",
            name: "safe-researcher",
            description: "Research agent with a constrained Claude Code profile",
          }),
          expect.objectContaining({
            value: "snake-case-reviewer",
            name: "snake-case-reviewer",
            description: "Review code with snake-case Claude agent metadata",
          }),
        ]),
      );
      expect(findCommand(commands, "reviewer")).toEqual(
        expect.objectContaining({
          kind: "agent",
          promptPrefix: "@agent-reviewer",
          metadata: {
            provider: "claude",
            source: "agent",
            model: "sonnet",
            tools: ["Read", "Grep"],
          },
        }),
      );
      expect(findCommand(commands, "safe-researcher")).toEqual(
        expect.objectContaining({
          kind: "agent",
          promptPrefix: "@agent-safe-researcher",
          metadata: {
            provider: "claude",
            source: "agent",
            tools: ["Read", "Grep", "Glob", "Bash"],
            disallowedTools: ["Write", "Edit"],
            model: "claude-haiku-4-5",
            permissionMode: "plan",
            mcpServers: {
              docs: {
                command: "docs-mcp",
                args: ["--stdio"],
              },
            },
            hooks: {
              SessionStart: [
                {
                  type: "command",
                  command: "./scripts/agent-start.sh",
                },
              ],
            },
            maxTurns: 8,
            skills: ["repo-map", "dependency-docs"],
            initialPrompt: "Summarize the current implementation context before researching.",
            effort: "high",
            background: true,
            isolation: "worktree",
            color: "teal",
            memory: {
              retain: "project-map",
            },
          },
        }),
      );
      expect(findCommand(commands, "snake-case-reviewer")).toEqual(
        expect.objectContaining({
          kind: "agent",
          promptPrefix: "@agent-snake-case-reviewer",
          metadata: {
            provider: "claude",
            source: "agent",
            allowedTools: ["Read", "Grep"],
            disallowedTools: ["Write", "Edit"],
            permissionMode: "acceptEdits",
            mcpServers: {
              repo: {
                command: "repo-mcp",
              },
            },
            maxTurns: 5,
            initialPrompt: "Start by summarizing the files you will inspect.",
            background: true,
          },
        }),
      );
      expect(findCommand(commands, "docs-writer")).toEqual(
        expect.objectContaining({
          metadata: {
            provider: "claude",
            source: "agent",
            allowedTools: "Read",
          },
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("converts Claude SDK supported agents into Ace agent commands", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ace-claude-sdk-agent-config-"));
    const repo = path.join(root, "repo");
    const cwd = path.join(repo, "packages", "web");
    const claudeHome = path.join(root, ".claude");
    try {
      await mkdir(path.join(repo, ".git"), { recursive: true });
      await mkdir(cwd, { recursive: true });
      await mkdir(path.join(repo, ".claude"), { recursive: true });
      await writeFile(
        path.join(repo, ".claude", "settings.json"),
        JSON.stringify({ permissions: { deny: ["Agent(hidden-reviewer)"] } }),
      );

      expect(
        discoverClaudeSdkAgentSlashCommands({
          cwd,
          home: claudeHome,
          agents: [
            {
              name: "sdk-auditor",
              description: "Audit implementation details from the Claude SDK",
              model: "sonnet",
              tools: ["Read", "Grep"],
              prompt: "Audit the current implementation with SDK context.",
              maxTurns: 6,
            },
            {
              name: "hidden-reviewer",
              description: "Denied by Claude settings",
            },
            {
              name: "!!!",
              description: "Invalid command name",
            },
          ],
        }),
      ).toEqual([
        {
          name: "sdk-auditor",
          kind: "agent",
          description: "Audit implementation details from the Claude SDK Model: sonnet.",
          promptPrefix: "@sdk-auditor",
          inputHint: "<prompt>",
          metadata: {
            provider: "claude",
            source: "sdk-agent",
            model: "sonnet",
            tools: ["Read", "Grep"],
            prompt: "Audit the current implementation with SDK context.",
            maxTurns: 6,
          },
        },
      ]);

      expect(
        discoverClaudeSdkAgentSlashCommands({
          cwd,
          home: claudeHome,
          agents: {
            "sdk-docs": {
              description: "Draft documentation from SDK agent config",
              model: "haiku",
              allowed_tools: "Read, Glob",
              prompt: "Draft docs from the current context.",
              max_turns: 4,
            },
            "hidden-reviewer": {
              description: "Denied by Claude settings",
            },
          },
        }),
      ).toEqual([
        {
          name: "sdk-docs",
          kind: "agent",
          description: "Draft documentation from SDK agent config Model: haiku.",
          promptPrefix: "@sdk-docs",
          inputHint: "<prompt>",
          metadata: {
            provider: "claude",
            source: "sdk-agent",
            model: "haiku",
            tools: ["Read", "Glob"],
            prompt: "Draft docs from the current context.",
            maxTurns: 4,
          },
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers Claude forked subagent config from environment and selected override", () => {
    expect(
      discoverClaudeForkSubagentsConfigOption({
        env: { CLAUDE_CODE_FORK_SUBAGENT: "1" },
      }),
    ).toEqual(
      expect.objectContaining({
        id: "fork_subagents",
        name: "Forks",
        category: "subagent_fork_mode",
        type: "select",
        currentValue: "on",
      }),
    );
    expect(
      discoverClaudeForkSubagentsConfigOption({
        selectedForkSubagents: false,
        env: { CLAUDE_CODE_FORK_SUBAGENT: "1" },
      }).currentValue,
    ).toBe("off");
  });

  it("preserves custom Claude subagent model ids without command-name normalization", () => {
    const option = discoverClaudeSubagentModelConfigOption({
      selectedSubagentModel: " anthropic/claude-opus-4.1 ",
      env: { CLAUDE_CODE_SUBAGENT_MODEL: "haiku" },
    });

    expect(option).toEqual(
      expect.objectContaining({
        id: "subagent_model",
        name: "Subagent Model",
        category: "subagent_model",
        type: "select",
        currentValue: "anthropic/claude-opus-4.1",
      }),
    );
    expect(option.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "inherit", name: "Inherit" }),
        expect.objectContaining({
          value: "anthropic/claude-opus-4.1",
          name: "anthropic/claude-opus-4.1",
        }),
      ]),
    );
  });

  it("discovers concrete Codex skill and plugin commands", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ace-extension-commands-"));
    const repo = path.join(root, "repo");
    const cwd = path.join(repo, "packages", "web");
    const codexHome = path.join(root, ".codex");
    const agentsHome = path.join(root, ".agents");
    try {
      await mkdir(path.join(repo, ".git"), { recursive: true });
      await mkdir(cwd, { recursive: true });
      await writeSkill(path.join(repo, ".codex", "skills"), "codex-local", "Codex local skill");
      await writeSkill(path.join(repo, ".codex", "skills"), "design-audit", "Local audit UI");
      await writeSkill(path.join(repo, ".agents", "skills"), "designx", "Design UI");
      await writeSkill(path.join(cwd, ".agents", "skills"), "module-skill", "Module skill");
      await writeSkill(path.join(agentsHome, "skills"), "frontend-design", "Build UI");
      await writeSkill(path.join(codexHome, "skills"), "design-audit", "Audit UI");
      await writeSkill(path.join(codexHome, "skills", ".system"), "imagegen", "Generate images");
      await mkdir(path.join(repo, ".codex", "agents"), { recursive: true });
      await writeFile(
        path.join(repo, ".codex", "agents", "reviewer.toml"),
        [
          'name = "reviewer"',
          'description = "Review code with a Codex custom agent"',
          'developer_instructions = """',
          "Review code carefully.",
          '"""',
          'nickname_candidates = ["Atlas", "Delta"]',
          'model = "gpt-5.4-mini"',
          'model_reasoning_effort = "low"',
          'sandbox_mode = "read-only"',
        ].join("\n"),
      );
      await writeFile(
        path.join(repo, ".codex", "agents", "explorer.toml"),
        [
          'name = "explorer"',
          'description = "Project-specific Codex explorer override"',
          'developer_instructions = "Explore this project using local conventions."',
        ].join("\n"),
      );
      await mkdir(path.join(codexHome, "agents"), { recursive: true });
      await writeFile(
        path.join(codexHome, "agents", "docs.toml"),
        [
          'name = "docs-writer"',
          'description = "Draft documentation with a Codex custom agent"',
          'developer_instructions = "Write docs."',
        ].join("\n"),
      );
      await writeFile(
        path.join(codexHome, "agents", "invalid.toml"),
        ['name = "invalid"', 'description = "Missing instructions"'].join("\n"),
      );
      await mkdir(path.join(codexHome, "prompts", "nested"), { recursive: true });
      await writeFile(
        path.join(codexHome, "prompts", "draftpr.md"),
        [
          "---",
          "description: Prep a draft PR",
          "argument-hint: FILES= PR_TITLE=",
          "---",
          "",
          "Draft a PR for $ARGUMENTS.",
        ].join("\n"),
      );
      await writeFile(
        path.join(codexHome, "prompts", "nested", "ignored.md"),
        "# Ignored nested prompt\n\nCodex scans top-level prompt files only.",
      );

      const pluginRoot = path.join(
        codexHome,
        "plugins",
        "cache",
        "openai-bundled",
        "browser-use",
        "1.0.0",
      );
      await mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
      await writeFile(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        JSON.stringify({
          name: "browser-use",
          description: "Browser automation",
          skills: "./skills/",
          interface: { shortDescription: "Control the browser" },
        }),
      );
      await writeSkill(path.join(pluginRoot, "skills"), "browser", "Use browser automation");
      await writeSkill(path.join(pluginRoot, "skills"), "inspect-page", "Inspect a page");

      const commands = discoverCodexExtensionSlashCommands({ cwd, codexHome, agentsHome });
      expect(commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "codex-local",
            kind: "skill",
            promptPrefix: "$codex-local",
          }),
          expect.objectContaining({
            name: "designx",
            kind: "skill",
            promptPrefix: "$designx",
          }),
          expect.objectContaining({
            name: "module-skill",
            kind: "skill",
            promptPrefix: "$module-skill",
          }),
          expect.objectContaining({
            name: "frontend-design",
            kind: "skill",
            promptPrefix: "$frontend-design",
          }),
          expect.objectContaining({
            name: "design-audit",
            kind: "skill",
            promptPrefix: "$design-audit",
          }),
          expect.objectContaining({
            name: "imagegen",
            kind: "skill",
            promptPrefix: "$imagegen",
          }),
          expect.objectContaining({
            name: "reviewer",
            kind: "agent",
            promptPrefix: "@reviewer",
            inputHint: "<prompt>",
            description: "Review code with a Codex custom agent",
            metadata: {
              provider: "codex",
              source: "agent",
              nicknameCandidates: ["Atlas", "Delta"],
              model: "gpt-5.4-mini",
              modelReasoningEffort: "low",
              sandboxMode: "read-only",
            },
          }),
          expect.objectContaining({
            name: "docs-writer",
            kind: "agent",
            promptPrefix: "@docs-writer",
            description: "Draft documentation with a Codex custom agent",
          }),
          expect.objectContaining({
            name: "default",
            kind: "agent",
            promptPrefix: "@default",
            metadata: {
              provider: "codex",
              source: "built-in-subagent",
            },
          }),
          expect.objectContaining({
            name: "worker",
            kind: "agent",
            promptPrefix: "@worker",
            description: "Use Codex's built-in implementation and fixes subagent.",
          }),
          expect.objectContaining({
            name: "prompts:draftpr",
            kind: "provider",
            promptPrefix: "/prompts:draftpr",
            inputHint: "FILES= PR_TITLE=",
            description: "Prep a draft PR",
          }),
          expect.objectContaining({
            name: "browser-use",
            kind: "plugin",
            promptPrefix: "@browser-use",
          }),
          expect.objectContaining({
            name: "browser-use:inspect-page",
            kind: "skill",
            promptPrefix: "$browser-use:inspect-page",
          }),
        ]),
      );
      expect(findCommand(commands, "browser-use:browser")).toBeUndefined();
      expect(findCommand(commands, "design-audit")?.description).toBe("Local audit UI");
      expect(findCommand(commands, "explorer")?.description).toBe(
        "Project-specific Codex explorer override",
      );
      expect(findCommand(commands, "explorer")?.metadata).toEqual({
        provider: "codex",
        source: "agent",
      });
      expect(findCommand(commands, "invalid")).toBeUndefined();
      expect(findCommand(commands, "prompts:ignored")).toBeUndefined();
      const providerCommands = withProviderExtensionSlashCommands({
        providers: [
          {
            provider: "codex",
            enabled: true,
            installed: true,
            version: "1.0.0",
            minimumVersion: null,
            versionStatus: "ok",
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-01-01T00:00:00.000Z",
            models: [],
          },
        ],
        cwd,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            codex: {
              enabled: true,
              binaryPath: "codex",
              homePath: codexHome,
              launchEnv: {},
              customModels: [],
              instances: [],
            },
          },
        },
        resolveCodexGoalsFeatureEnabled: () => false,
      })[0]?.commands;

      expect(providerCommands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "codex-local",
            kind: "skill",
            promptPrefix: "$codex-local",
          }),
          expect.objectContaining({
            name: "designx",
            kind: "skill",
            promptPrefix: "$designx",
          }),
          expect.objectContaining({
            name: "module-skill",
            kind: "skill",
            promptPrefix: "$module-skill",
          }),
          expect.objectContaining({
            name: "design-audit",
            kind: "skill",
            promptPrefix: "$design-audit",
          }),
          expect.objectContaining({
            name: "prompts:draftpr",
            kind: "provider",
            promptPrefix: "/prompts:draftpr",
          }),
          expect.objectContaining({
            name: "reviewer",
            kind: "agent",
            promptPrefix: "@reviewer",
          }),
          expect.objectContaining({
            name: "worker",
            kind: "agent",
            promptPrefix: "@worker",
          }),
          expect.objectContaining({
            name: "browser-use",
            kind: "plugin",
            promptPrefix: "@browser-use",
          }),
          expect.objectContaining({
            name: "goal",
            kind: "provider",
          }),
        ]),
      );
      expect(findCommand(providerCommands ?? [], "design-audit")?.description).toBe(
        "Local audit UI",
      );
      expect(findCommand(providerCommands ?? [], "goal")?.description).toBe(
        "Set or inspect the active long-running goal",
      );
      expect(
        withProviderExtensionSlashCommands({
          providers: [
            {
              provider: "gemini",
              enabled: true,
              installed: true,
              version: "1.0.0",
              minimumVersion: null,
              versionStatus: "ok",
              status: "ready",
              auth: { status: "authenticated" },
              checkedAt: "2026-01-01T00:00:00.000Z",
              models: [],
            },
          ],
          cwd,
          settings: DEFAULT_SERVER_SETTINGS,
        })[0]?.commands,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "codebase_investigator",
            kind: "agent",
            promptPrefix: "@codebase_investigator",
          }),
          expect.objectContaining({
            name: "cli_help",
            kind: "agent",
            promptPrefix: "@cli_help",
          }),
          expect.objectContaining({
            name: "generalist",
            kind: "agent",
            promptPrefix: "@generalist",
          }),
          expect.objectContaining({
            name: "designx",
            kind: "skill",
            promptPrefix: "Use the designx skill:",
          }),
        ]),
      );
      expect(
        findCommand(
          withProviderExtensionSlashCommands({
            providers: [
              {
                provider: "gemini",
                enabled: true,
                installed: true,
                version: "1.0.0",
                minimumVersion: null,
                versionStatus: "ok",
                status: "ready",
                auth: { status: "authenticated" },
                checkedAt: "2026-01-01T00:00:00.000Z",
                models: [],
              },
            ],
            cwd,
            settings: DEFAULT_SERVER_SETTINGS,
          })[0]?.commands ?? [],
          "codebase_investigator",
        )?.metadata,
      ).toEqual({
        provider: "gemini",
        source: "built-in-subagent",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers Claude installed plugin skills and plugin slash commands", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ace-claude-extension-commands-"));
    const cwd = path.join(root, "repo");
    const nestedCwd = path.join(cwd, "packages", "web");
    const claudeHome = path.join(root, ".claude");
    const agentsHome = path.join(root, ".agents");
    const pluginRoot = path.join(
      claudeHome,
      "plugins",
      "cache",
      "acme-marketplace",
      "acme-plugin",
      "1.0.0",
    );
    const rootSkillPluginRoot = path.join(
      claudeHome,
      "plugins",
      "cache",
      "acme-marketplace",
      "single-skill-plugin",
      "1.0.0",
    );
    try {
      await mkdir(path.join(cwd, ".git"), { recursive: true });
      await mkdir(nestedCwd, { recursive: true });
      await mkdir(path.join(claudeHome, "plugins"), { recursive: true });
      await mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
      await writeFile(
        path.join(claudeHome, "plugins", "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: {
            "acme-plugin@acme-marketplace": [
              {
                installPath: pluginRoot,
                version: "1.0.0",
              },
            ],
            "single-skill-plugin@acme-marketplace": [
              {
                installPath: rootSkillPluginRoot,
                version: "1.0.0",
              },
            ],
          },
        }),
      );
      await writeFile(
        path.join(pluginRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify({
          name: "acme-plugin",
          description: "Acme provider plugin",
          agents: "agents",
          skills: "skills",
          commands: "commands",
        }),
      );
      await writeAgentMarkdown({
        root: path.join(pluginRoot, "agents"),
        fileName: "incident.md",
        name: "incident-agent",
        description: "Investigate incidents through the Acme plugin",
      });
      await writeAgentMarkdown({
        root: path.join(pluginRoot, "agents", "review"),
        fileName: "security.md",
        name: "security-auditor",
        description: "Audit security through the Acme plugin",
      });
      await writeSkill(path.join(pluginRoot, "skills"), "deploy-review", "Review deployments");
      await mkdir(path.join(rootSkillPluginRoot, ".claude-plugin"), { recursive: true });
      await writeFile(
        path.join(rootSkillPluginRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify({
          name: "single-skill-plugin",
          description: "Single skill plugin",
        }),
      );
      await writeFile(
        path.join(rootSkillPluginRoot, "SKILL.md"),
        "---\nname: root-review\ndescription: Root plugin skill\n---\n\n# Root plugin skill\n",
      );
      await writeSkill(
        path.join(cwd, ".claude", "skills"),
        "claude-project",
        "Claude project skill",
        [
          "arguments: [target, format]",
          "allowed-tools: [Read, Grep]",
          "model: sonnet",
          "context: fork",
          "agent: Explore",
          'hooks: {"SkillStart":[{"type":"command","command":"./scripts/skill-start.sh"}]}',
        ],
      );
      await writeSkill(path.join(cwd, ".claude", "skills"), "release", "Claude release skill");
      await mkdir(path.join(cwd, ".claude", "skills", "workflow", "folder-command"), {
        recursive: true,
      });
      await writeFile(
        path.join(cwd, ".claude", "skills", "workflow", "folder-command", "SKILL.md"),
        "---\nname: Display Name Only\ndescription: Uses the folder name as the slash command\n---\n\n# Folder command\n",
      );
      await writeSkill(
        path.join(cwd, ".claude", "skills"),
        "shared-global",
        "Claude project override",
      );
      await mkdir(path.join(cwd, ".claude", "commands", "frontend"), { recursive: true });
      await writeFile(
        path.join(cwd, ".claude", "commands", "release.md"),
        "---\ndescription: Draft release notes\nargument-hint: <version>\n---\n\n# Release\n",
      );
      await writeFile(
        path.join(cwd, ".claude", "commands", "frontend", "widget.md"),
        [
          "---",
          "arguments: [name, variant]",
          "allowed-tools: Bash(git status *), Read",
          "disable-model-invocation: true",
          "---",
          "",
          "# Widget",
          "",
          "Create a widget using $ARGUMENTS.",
        ].join("\n"),
      );
      await writeFile(
        path.join(cwd, ".claude", "commands", "frontend", "manual.md"),
        [
          "---",
          "description: Manual-only frontend command",
          "disableModelInvocation: true",
          "---",
          "",
          "# Manual",
        ].join("\n"),
      );
      await writeSkill(path.join(claudeHome, "skills"), "claude-global", "Claude global skill");
      await mkdir(path.join(claudeHome, "commands"), { recursive: true });
      await writeFile(
        path.join(claudeHome, "commands", "changelog.md"),
        "---\ndescription: Update changelog\n---\n\n# Changelog\n",
      );
      await writeFile(
        path.join(claudeHome, "commands", "release.md"),
        "---\ndescription: User release command\n---\n\n# User release\n",
      );
      await writeAgentMarkdown({
        root: path.join(cwd, ".claude", "agents", "review"),
        fileName: "security.md",
        name: "security-auditor",
        description: "Audit code for security problems",
      });
      await writeAgentMarkdown({
        root: path.join(cwd, ".claude", "agents"),
        fileName: "explore.md",
        name: "explore",
        description: "Project Explore override",
      });
      await writeAgentMarkdown({
        root: path.join(claudeHome, "agents"),
        fileName: "docs-writer.md",
        name: "docs-writer",
        description: "Draft documentation",
      });
      await writeSkill(path.join(agentsHome, "skills"), "shared-global", "Shared global skill");
      await mkdir(path.join(pluginRoot, "commands"), { recursive: true });
      await writeFile(
        path.join(pluginRoot, "commands", "deploy.md"),
        "---\ndescription: Deploy with Acme\n---\n\n# Deploy\n",
      );

      const commands = discoverClaudeExtensionSlashCommands({ cwd, home: claudeHome, agentsHome });
      expect(commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "security-auditor",
            kind: "agent",
            promptPrefix: "@agent-security-auditor",
          }),
          expect.objectContaining({
            name: "explore",
            kind: "agent",
            description: "Project Explore override",
            promptPrefix: "@agent-explore",
          }),
          expect.objectContaining({
            name: "docs-writer",
            kind: "agent",
            promptPrefix: "@agent-docs-writer",
          }),
          expect.objectContaining({
            name: "claude-project",
            kind: "skill",
            promptPrefix: "/claude-project",
          }),
          expect.objectContaining({
            name: "claude-global",
            kind: "skill",
            promptPrefix: "/claude-global",
          }),
          expect.objectContaining({
            name: "shared-global",
            kind: "skill",
            promptPrefix: "/shared-global",
          }),
          expect.objectContaining({
            name: "release",
            kind: "skill",
            description: "Claude release skill",
            promptPrefix: "/release",
          }),
          expect.objectContaining({
            name: "folder-command",
            kind: "skill",
            description: "Uses the folder name as the slash command",
            promptPrefix: "/folder-command",
          }),
          expect.objectContaining({
            name: "widget",
            kind: "provider",
            description: "Widget",
            promptPrefix: "/widget",
            inputHint: "[name] [variant]",
          }),
          expect.objectContaining({
            name: "manual",
            kind: "provider",
            description: "Manual-only frontend command",
            promptPrefix: "/manual",
            metadata: {
              provider: "claude",
              source: "command",
              disableModelInvocation: true,
            },
          }),
          expect.objectContaining({
            name: "changelog",
            kind: "provider",
            description: "Update changelog",
            promptPrefix: "/changelog",
          }),
          expect.objectContaining({
            name: "acme-plugin",
            kind: "plugin",
            promptPrefix: "Use the acme-plugin plugin.",
          }),
          expect.objectContaining({
            name: "acme-plugin:incident-agent",
            kind: "agent",
            promptPrefix: "@agent-acme-plugin:incident-agent",
          }),
          expect.objectContaining({
            name: "acme-plugin:review:security-auditor",
            kind: "agent",
            description: "Audit security through the Acme plugin",
            promptPrefix: "@agent-acme-plugin:review:security-auditor",
          }),
          expect.objectContaining({
            name: "acme-plugin:deploy-review",
            kind: "skill",
            promptPrefix: "/acme-plugin:deploy-review",
          }),
          expect.objectContaining({
            name: "root-review",
            kind: "skill",
            description: "Root plugin skill",
            promptPrefix: "/root-review",
          }),
          expect.objectContaining({
            name: "acme-plugin:deploy",
            kind: "plugin",
            promptPrefix: "/acme-plugin:deploy",
          }),
        ]),
      );
      expect(findCommand(commands, "shared-global")?.description).toBe("Claude project override");
      expect(findCommand(commands, "release")?.description).toBe("Claude release skill");
      expect(findCommand(commands, "claude-project")?.inputHint).toBe("[target] [format]");
      expect(findCommand(commands, "claude-project")?.metadata).toEqual({
        provider: "claude",
        source: "skill",
        arguments: ["target", "format"],
        allowedTools: ["Read", "Grep"],
        model: "sonnet",
        context: "fork",
        agent: "Explore",
        hooks: {
          SkillStart: [
            {
              type: "command",
              command: "./scripts/skill-start.sh",
            },
          ],
        },
      });
      expect(findCommand(commands, "widget")?.inputHint).toBe("[name] [variant]");
      expect(findCommand(commands, "widget")?.metadata).toEqual({
        provider: "claude",
        source: "command",
        arguments: ["name", "variant"],
        allowedTools: ["Bash(git status *)", "Read"],
        disableModelInvocation: true,
      });
      expect(findCommand(commands, "folder-command")?.promptPrefix).toBe("/folder-command");
      expect(findCommand(commands, "Display Name Only")).toBeUndefined();
      expect(
        findCommand(
          discoverClaudeExtensionSlashCommands({ cwd: nestedCwd, home: claudeHome, agentsHome }),
          "claude-project",
        )?.promptPrefix,
      ).toBe("/claude-project");
      expect(
        findCommand(
          discoverClaudeExtensionSlashCommands({ cwd: nestedCwd, home: claudeHome, agentsHome }),
          "widget",
        )?.promptPrefix,
      ).toBe("/widget");

      const providerCommands = withProviderExtensionSlashCommands({
        providers: [
          {
            provider: "claudeAgent",
            enabled: true,
            installed: true,
            version: "1.0.0",
            minimumVersion: null,
            versionStatus: "ok",
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-01-01T00:00:00.000Z",
            models: [],
          },
        ],
        cwd,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            claudeAgent: {
              ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
              configDir: claudeHome,
            },
          },
        },
      })[0]?.commands;

      expect(providerCommands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "changelog",
            kind: "provider",
            promptPrefix: "/changelog",
          }),
          expect.objectContaining({
            name: "explore",
            kind: "agent",
            description: "Project Explore override",
            promptPrefix: "@agent-explore",
          }),
          expect.objectContaining({
            name: "plan",
            kind: "agent",
            promptPrefix: "@agent-plan",
          }),
          expect.objectContaining({
            name: "general-purpose",
            kind: "agent",
            promptPrefix: "@agent-general-purpose",
          }),
        ]),
      );
      expect(findCommand(providerCommands ?? [], "explore")?.description).toBe(
        "Project Explore override",
      );
      expect(findCommand(providerCommands ?? [], "plan")?.metadata).toEqual({
        provider: "claude",
        source: "built-in-subagent",
      });
      await mkdir(path.join(cwd, ".claude"), { recursive: true });
      await writeFile(
        path.join(cwd, ".claude", "settings.json"),
        JSON.stringify({
          permissions: {
            deny: ["Agent(security-auditor)", "Agent(incident-agent)", "Agent(plan)"],
          },
        }),
      );
      const filteredCommands = discoverClaudeExtensionSlashCommands({
        cwd,
        home: claudeHome,
        agentsHome,
      });
      expect(findCommand(filteredCommands, "security-auditor")).toBeUndefined();
      expect(findCommand(filteredCommands, "acme-plugin:incident-agent")).toBeUndefined();
      expect(findCommand(filteredCommands, "release")).toEqual(
        expect.objectContaining({
          kind: "skill",
          promptPrefix: "/release",
        }),
      );
      const filteredProviderCommands = withProviderExtensionSlashCommands({
        providers: [
          {
            provider: "claudeAgent",
            enabled: true,
            installed: true,
            version: "1.0.0",
            minimumVersion: null,
            versionStatus: "ok",
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-01-01T00:00:00.000Z",
            models: [],
          },
        ],
        cwd,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            claudeAgent: {
              ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
              configDir: claudeHome,
            },
          },
        },
      })[0]?.commands;
      expect(findCommand(filteredProviderCommands ?? [], "security-auditor")).toBeUndefined();
      expect(
        findCommand(filteredProviderCommands ?? [], "acme-plugin:incident-agent"),
      ).toBeUndefined();
      expect(findCommand(filteredProviderCommands ?? [], "plan")).toBeUndefined();
      expect(findCommand(filteredProviderCommands ?? [], "general-purpose")).toEqual(
        expect.objectContaining({
          kind: "agent",
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers generic provider skill roots", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ace-generic-extension-commands-"));
    const cwd = path.join(root, "repo");
    const nestedCwd = path.join(cwd, "packages", "web");
    const geminiHome = path.join(root, ".gemini");
    const agentsHome = path.join(root, ".agents");
    try {
      await mkdir(path.join(cwd, ".git"), { recursive: true });
      await mkdir(nestedCwd, { recursive: true });
      await writeSkill(path.join(cwd, ".gemini", "skills"), "gemini-project", "Gemini project");
      await writeSkill(path.join(cwd, ".agents", "skills"), "designx", "Project shared skill");
      await writeSkill(
        path.join(cwd, ".agents", "skills"),
        "frontend-design",
        "Project frontend design",
      );
      await writeSkill(path.join(geminiHome, "skills"), "frontend-design", "Build UI");
      await mkdir(path.join(cwd, ".gemini", "agents"), { recursive: true });
      await writeFile(
        path.join(cwd, ".gemini", "agents", "security-auditor.md"),
        [
          "---",
          "name: security-auditor",
          "description: Find security defects",
          "kind: local",
          "tools: [read_file, grep_search]",
          "model: gemini-3-flash-preview",
          "temperature: 0.2",
          "maxTurns: 10",
          "timeout_mins: 12",
          "mcpServers:",
          "  audit:",
          "    command: node",
          "    args:",
          "      - audit-server.js",
          "---",
          "",
          "# Agent prompt",
        ].join("\n"),
      );
      await writeFile(
        path.join(cwd, ".gemini", "agents", "remote-auditor.md"),
        [
          "---",
          "kind: remote",
          "name: remote-auditor",
          "description: Audit through a remote A2A agent",
          "agent_card_url: https://example.com/remote-auditor/.well-known/agent.json",
          "---",
          "",
          "Remote A2A agent configuration.",
        ].join("\n"),
      );
      await writeFile(
        path.join(cwd, ".gemini", "agents", "remote-camel.md"),
        [
          "---",
          "kind: remote",
          "name: remote-camel",
          "description: Uses camel-case remote A2A metadata",
          "agentCardUrl: https://example.com/remote-camel/.well-known/agent.json",
          "---",
          "",
          "Remote A2A agent configuration.",
        ].join("\n"),
      );
      await writeFile(
        path.join(cwd, ".gemini", "agents", "remote-pack.md"),
        [
          "---",
          "- kind: remote",
          "  name: remote-architect",
          "  agent_card_url: https://example.com/remote-architect/.well-known/agent.json",
          "- kind: remote",
          "  name: remote-hyphen",
          "  agent-card-url: https://example.com/remote-hyphen/.well-known/agent.json",
          "- kind: remote",
          "  name: remote-docs",
          '  agent_card_json: \'{ "protocolVersion": "0.3.0", "name": "Docs" }\'',
          "---",
          "",
          "Multiple remote A2A agents.",
        ].join("\n"),
      );
      await writeFile(
        path.join(cwd, ".gemini", "agents", "remote-json-block.md"),
        [
          "---",
          "kind: remote",
          "name: remote-json-block",
          "description: Uses an inline A2A agent card",
          "agent_card_json: |",
          '  { "protocolVersion": "0.3.0", "name": "Inline Remote", "version": "1.0.0" }',
          "---",
          "",
          "Remote A2A agent configuration with an inline card.",
        ].join("\n"),
      );
      await writeFile(
        path.join(cwd, ".gemini", "agents", "remote-auth.md"),
        [
          "---",
          "kind: remote",
          "name: remote-auth",
          "description: Uses sanitized remote auth metadata",
          "agent_card_url: https://example.com/remote-auth/.well-known/agent.json",
          "auth:",
          "  type: oauth2",
          "  scheme: bearer",
          "  scopes:",
          "    - repo:read",
          "  authorization_url: https://auth.example.test/oauth/authorize",
          "  token_url: https://auth.example.test/oauth/token",
          "  client_secret: should-not-leak",
          "  token: should-not-leak",
          "---",
          "",
          "Remote A2A agent with auth.",
        ].join("\n"),
      );
      await writeAgentMarkdown({
        root: path.join(geminiHome, "agents"),
        fileName: "global-researcher.md",
        name: "global-researcher",
        description: "Research global Gemini context",
      });
      await writeFile(
        path.join(cwd, ".gemini", "agents", "missing-name.md"),
        "---\ndescription: Missing required Gemini name\n---\n\n# Agent prompt\n",
      );
      await writeFile(
        path.join(cwd, ".gemini", "agents", "missing-description.md"),
        "---\nname: missing-description\n---\n\n# Agent prompt\n",
      );
      await writeSkill(path.join(agentsHome, "skills"), "shared-global", "Shared global skill");
      const extensionRoot = path.join(geminiHome, "extensions", "gcp");
      await mkdir(extensionRoot, { recursive: true });
      await writeFile(
        path.join(extensionRoot, "gemini-extension.json"),
        JSON.stringify({
          name: "gcp",
          version: "1.0.0",
          description: "Google Cloud extension",
        }),
      );
      await writeSkill(
        path.join(extensionRoot, "skills"),
        "cloud-run-deploy",
        "Deploy Cloud Run services",
      );
      await mkdir(path.join(extensionRoot, "agents"), { recursive: true });
      await writeFile(
        path.join(extensionRoot, "agents", "cloud-architect.md"),
        [
          "---",
          "name: cloud-architect",
          "description: Design Google Cloud architecture",
          "kind: local",
          "tools:",
          "  - read_file",
          "  - mcp_gcp_*",
          "model: gemini-3-pro-preview",
          "max_turns: 20",
          "---",
          "",
          "# Agent prompt",
        ].join("\n"),
      );
      await mkdir(path.join(extensionRoot, "commands", "gcs"), { recursive: true });
      await writeFile(
        path.join(extensionRoot, "commands", "gcs", "sync.toml"),
        'description = "Sync Cloud Storage buckets"\nprompt = "Sync Cloud Storage buckets for {{args}}."\n',
      );
      await writeFile(
        path.join(extensionRoot, "commands", "review.toml"),
        'description = "Review with Google Cloud context"\nprompt = "Review {{args}} with Google Cloud context."\n',
      );
      await mkdir(path.join(cwd, ".gemini", "commands", "git"), { recursive: true });
      await writeFile(
        path.join(cwd, ".gemini", "commands", "review.toml"),
        'description = "Review the current diff"\nprompt = "Review {{args}}."\n',
      );
      await writeFile(
        path.join(cwd, ".gemini", "commands", "git", "commit.toml"),
        'description = "Draft a commit message"\nprompt = "Draft a commit for {{args}}."\n',
      );
      await writeFile(
        path.join(cwd, ".gemini", "commands", "context.toml"),
        [
          'description = "Review with injected Gemini context"',
          'prompt = """',
          "Review {{args}} with these project notes:",
          "@{docs/best-practices.md}",
          "",
          "Current status:",
          "!{git status --short}",
          '"""',
        ].join("\n"),
      );
      await mkdir(path.join(geminiHome, "commands"), { recursive: true });
      await writeFile(
        path.join(geminiHome, "commands", "review.toml"),
        'description = "Global review command"\nprompt = "Review globally."\n',
      );
      await writeFile(
        path.join(geminiHome, "commands", "triage.toml"),
        'description = "Triage an issue"\nprompt = "Triage {{args}}."\n',
      );
      await writeFile(
        path.join(geminiHome, "commands", "missing-prompt.toml"),
        'description = "This command is invalid without a prompt"\n',
      );
      await writeFile(
        path.join(geminiHome, "commands", "explain.toml"),
        'prompt = """\nExplain this code path.\n\nFocus on {{args}}.\n"""\n',
      );

      const commands = discoverGenericProviderExtensionSlashCommands({
        cwd,
        home: geminiHome,
        agentsHome,
        providerHomeDirName: ".gemini",
      });
      expect(commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "security-auditor",
            kind: "agent",
            promptPrefix: "@security-auditor",
          }),
          expect.objectContaining({
            name: "gemini-project",
            kind: "skill",
            promptPrefix: "Use the gemini-project skill:",
          }),
          expect.objectContaining({
            name: "designx",
            kind: "skill",
            promptPrefix: "Use the designx skill:",
          }),
          expect.objectContaining({
            name: "frontend-design",
            kind: "skill",
            promptPrefix: "Use the frontend-design skill:",
          }),
          expect.objectContaining({
            name: "shared-global",
            kind: "skill",
            promptPrefix: "Use the shared-global skill:",
          }),
        ]),
      );
      expect(findCommand(commands, "frontend-design")?.description).toBe("Project frontend design");
      const nestedCommands = discoverGenericProviderExtensionSlashCommands({
        cwd: nestedCwd,
        home: geminiHome,
        agentsHome,
        providerHomeDirName: ".gemini",
      });
      expect(nestedCommands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "security-auditor",
            kind: "agent",
            promptPrefix: "@security-auditor",
          }),
          expect.objectContaining({
            name: "gemini-project",
            kind: "skill",
            promptPrefix: "Use the gemini-project skill:",
          }),
        ]),
      );
      const customCommands = discoverGeminiCustomSlashCommands({ cwd, home: geminiHome });
      expect(customCommands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "security-auditor",
            kind: "agent",
            promptPrefix: "@security-auditor",
            description: "Find security defects",
            metadata: {
              provider: "gemini",
              source: "agent",
              kind: "local",
              tools: ["read_file", "grep_search"],
              model: "gemini-3-flash-preview",
              temperature: 0.2,
              maxTurns: 10,
              timeoutMins: 12,
              mcpServers: {
                audit: {
                  command: "node",
                  args: ["audit-server.js"],
                },
              },
            },
          }),
          expect.objectContaining({
            name: "global-researcher",
            kind: "agent",
            promptPrefix: "@global-researcher",
            description: "Research global Gemini context",
          }),
          expect.objectContaining({
            name: "remote-auditor",
            kind: "agent",
            promptPrefix: "@remote-auditor",
            description: "Audit through a remote A2A agent",
            metadata: expect.objectContaining({
              provider: "gemini",
              source: "remote-agent",
              kind: "remote",
              agentCardUrl: "https://example.com/remote-auditor/.well-known/agent.json",
            }),
          }),
          expect.objectContaining({
            name: "remote-camel",
            kind: "agent",
            promptPrefix: "@remote-camel",
            description: "Uses camel-case remote A2A metadata",
            metadata: expect.objectContaining({
              provider: "gemini",
              source: "remote-agent",
              kind: "remote",
              agentCardUrl: "https://example.com/remote-camel/.well-known/agent.json",
            }),
          }),
          expect.objectContaining({
            name: "remote-architect",
            kind: "agent",
            promptPrefix: "@remote-architect",
            description:
              "Remote Gemini A2A subagent at https://example.com/remote-architect/.well-known/agent.json",
          }),
          expect.objectContaining({
            name: "remote-hyphen",
            kind: "agent",
            promptPrefix: "@remote-hyphen",
            description:
              "Remote Gemini A2A subagent at https://example.com/remote-hyphen/.well-known/agent.json",
            metadata: expect.objectContaining({
              provider: "gemini",
              source: "remote-agent",
              kind: "remote",
              agentCardUrl: "https://example.com/remote-hyphen/.well-known/agent.json",
            }),
          }),
          expect.objectContaining({
            name: "remote-docs",
            kind: "agent",
            promptPrefix: "@remote-docs",
            description: "Remote Gemini A2A subagent",
          }),
          expect.objectContaining({
            name: "remote-json-block",
            kind: "agent",
            promptPrefix: "@remote-json-block",
            description: "Uses an inline A2A agent card",
            metadata: expect.objectContaining({
              provider: "gemini",
              source: "remote-agent",
              kind: "remote",
              agentCardJson:
                '{ "protocolVersion": "0.3.0", "name": "Inline Remote", "version": "1.0.0" }',
            }),
          }),
          expect.objectContaining({
            name: "remote-auth",
            kind: "agent",
            promptPrefix: "@remote-auth",
            description: "Uses sanitized remote auth metadata",
            metadata: expect.objectContaining({
              provider: "gemini",
              source: "remote-agent",
              kind: "remote",
              agentCardUrl: "https://example.com/remote-auth/.well-known/agent.json",
              authType: "oauth2",
              auth: {
                type: "oauth2",
                scheme: "bearer",
                scopes: ["repo:read"],
                authorizationUrl: "https://auth.example.test/oauth/authorize",
                tokenUrl: "https://auth.example.test/oauth/token",
              },
            }),
          }),
          expect.objectContaining({
            name: "review",
            kind: "provider",
            promptPrefix: "Review {{args}}.",
            description: "Review the current diff",
          }),
          expect.objectContaining({
            name: "git:commit",
            kind: "provider",
            promptPrefix: "Draft a commit for {{args}}.",
            description: "Draft a commit message",
            metadata: {
              provider: "gemini",
              source: "command",
              arguments: ["args"],
            },
          }),
          expect.objectContaining({
            name: "context",
            kind: "provider",
            description: "Review with injected Gemini context",
            metadata: {
              provider: "gemini",
              source: "command",
              arguments: ["args"],
              shellInjection: true,
              fileInjection: true,
            },
          }),
          expect.objectContaining({
            name: "triage",
            kind: "provider",
            promptPrefix: "Triage {{args}}.",
            description: "Triage an issue",
          }),
          expect.objectContaining({
            name: "explain",
            kind: "provider",
            promptPrefix: "Explain this code path.\n\nFocus on {{args}}.",
            description: "Explain",
          }),
        ]),
      );
      expect(findCommand(customCommands, "review")?.description).toBe("Review the current diff");
      expect(JSON.stringify(findCommand(customCommands, "remote-auth")?.metadata)).not.toContain(
        "should-not-leak",
      );
      expect(findCommand(customCommands, "missing-name")).toBeUndefined();
      expect(findCommand(customCommands, "missing-description")).toBeUndefined();
      expect(findCommand(customCommands, "missing-prompt")).toBeUndefined();
      expect(discoverGeminiCustomSlashCommands({ cwd: nestedCwd, home: geminiHome })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "review",
            kind: "provider",
            promptPrefix: "Review {{args}}.",
            description: "Review the current diff",
          }),
          expect.objectContaining({
            name: "git:commit",
            kind: "provider",
            promptPrefix: "Draft a commit for {{args}}.",
            description: "Draft a commit message",
          }),
        ]),
      );
      const extensionCommands = discoverGeminiExtensionSlashCommands({ cwd, home: geminiHome });
      expect(extensionCommands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "cloud-architect",
            kind: "agent",
            promptPrefix: "@cloud-architect",
            metadata: {
              provider: "gemini",
              source: "agent",
              kind: "local",
              tools: ["read_file", "mcp_gcp_*"],
              model: "gemini-3-pro-preview",
              maxTurns: 20,
            },
          }),
          expect.objectContaining({
            name: "cloud-run-deploy",
            kind: "skill",
            promptPrefix: "Use the cloud-run-deploy skill:",
          }),
          expect.objectContaining({
            name: "gcs:sync",
            kind: "plugin",
            promptPrefix: "Sync Cloud Storage buckets for {{args}}.",
            description: "Sync Cloud Storage buckets",
          }),
          expect.objectContaining({
            name: "review",
            kind: "plugin",
            promptPrefix: "Review {{args}} with Google Cloud context.",
            description: "Review with Google Cloud context",
          }),
        ]),
      );
      await writeFile(
        path.join(geminiHome, "extensions", "extension-enablement.json"),
        JSON.stringify({
          gcp: { overrides: [`!${cwd}/*`] },
        }),
      );
      expect(
        findCommand(discoverGeminiExtensionSlashCommands({ cwd, home: geminiHome }), "gcs:sync"),
      ).toBeUndefined();
      await writeFile(
        path.join(geminiHome, "extensions", "extension-enablement.json"),
        JSON.stringify({
          gcp: { overrides: [`!${cwd}/*`, `${nestedCwd}/*`] },
        }),
      );
      expect(
        findCommand(
          discoverGeminiExtensionSlashCommands({ cwd: nestedCwd, home: geminiHome }),
          "gcs:sync",
        ),
      ).toEqual(
        expect.objectContaining({
          kind: "plugin",
        }),
      );
      await writeFile(
        path.join(geminiHome, "extensions", "extension-enablement.json"),
        JSON.stringify({
          gcp: { overrides: [`${cwd}/*`] },
        }),
      );
      const providerCommands = withProviderExtensionSlashCommands({
        providers: [
          {
            provider: "gemini",
            enabled: true,
            installed: true,
            version: "1.0.0",
            minimumVersion: null,
            versionStatus: "ok",
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-01-01T00:00:00.000Z",
            models: [],
          },
        ],
        cwd,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            gemini: {
              ...DEFAULT_SERVER_SETTINGS.providers.gemini,
              configDir: geminiHome,
            },
          },
        },
      })[0]?.commands;
      expect(providerCommands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "review",
            kind: "provider",
            promptPrefix: "Review {{args}}.",
          }),
          expect.objectContaining({
            name: "triage",
            kind: "provider",
            promptPrefix: "Triage {{args}}.",
          }),
          expect.objectContaining({
            name: "gcs:sync",
            kind: "plugin",
            promptPrefix: "Sync Cloud Storage buckets for {{args}}.",
          }),
          expect.objectContaining({
            name: "gcp.review",
            kind: "plugin",
            promptPrefix: "Review {{args}} with Google Cloud context.",
          }),
        ]),
      );
      expect(findCommand(providerCommands ?? [], "browser_agent")).toBeUndefined();
      await mkdir(path.join(cwd, ".gemini"), { recursive: true });
      await writeFile(
        path.join(cwd, ".gemini", "settings.json"),
        JSON.stringify({
          extensions: {
            disabled: ["gcp"],
          },
        }),
      );
      expect(
        findCommand(discoverGeminiExtensionSlashCommands({ cwd, home: geminiHome }), "gcs:sync"),
      ).toBeUndefined();
      await writeFile(
        path.join(cwd, ".gemini", "settings.json"),
        JSON.stringify({
          agents: {
            overrides: {
              browser_agent: { enabled: true },
            },
          },
        }),
      );
      const browserEnabledCommands = withProviderExtensionSlashCommands({
        providers: [
          {
            provider: "gemini",
            enabled: true,
            installed: true,
            version: "1.0.0",
            minimumVersion: null,
            versionStatus: "ok",
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-01-01T00:00:00.000Z",
            models: [],
          },
        ],
        cwd,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            gemini: {
              ...DEFAULT_SERVER_SETTINGS.providers.gemini,
              configDir: geminiHome,
            },
          },
        },
      })[0]?.commands;
      expect(findCommand(browserEnabledCommands ?? [], "browser_agent")).toEqual(
        expect.objectContaining({
          kind: "agent",
          promptPrefix: "@browser_agent",
        }),
      );
      await writeFile(
        path.join(cwd, ".gemini", "settings.json"),
        JSON.stringify({
          agents: {
            overrides: {
              codebase_investigator: { enabled: false },
              "security-auditor": { enabled: false },
              browser_agent: { enabled: false },
            },
          },
        }),
      );
      const filteredProviderCommands = withProviderExtensionSlashCommands({
        providers: [
          {
            provider: "gemini",
            enabled: true,
            installed: true,
            version: "1.0.0",
            minimumVersion: null,
            versionStatus: "ok",
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-01-01T00:00:00.000Z",
            models: [],
          },
        ],
        cwd,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            gemini: {
              ...DEFAULT_SERVER_SETTINGS.providers.gemini,
              configDir: geminiHome,
            },
          },
        },
      })[0]?.commands;
      expect(findCommand(filteredProviderCommands ?? [], "codebase_investigator")).toBeUndefined();
      expect(findCommand(filteredProviderCommands ?? [], "security-auditor")).toBeUndefined();
      expect(findCommand(filteredProviderCommands ?? [], "browser_agent")).toBeUndefined();
      expect(findCommand(filteredProviderCommands ?? [], "review")).toEqual(
        expect.objectContaining({
          kind: "provider",
          promptPrefix: "Review {{args}}.",
        }),
      );
      await writeFile(
        path.join(cwd, ".gemini", "settings.json"),
        JSON.stringify({
          experimental: { enableAgents: false },
        }),
      );
      const disabledProviderCommands = withProviderExtensionSlashCommands({
        providers: [
          {
            provider: "gemini",
            enabled: true,
            installed: true,
            version: "1.0.0",
            minimumVersion: null,
            versionStatus: "ok",
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-01-01T00:00:00.000Z",
            models: [],
          },
        ],
        cwd,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            gemini: {
              ...DEFAULT_SERVER_SETTINGS.providers.gemini,
              configDir: geminiHome,
            },
          },
        },
      })[0]?.commands;
      expect(disabledProviderCommands?.some((command) => command.kind === "agent")).toBe(false);
      expect(geminiBuiltInSubagentCommands({ cwd, home: geminiHome })).toEqual([]);
      expect(findCommand(disabledProviderCommands ?? [], "review")).toEqual(
        expect.objectContaining({
          kind: "provider",
          promptPrefix: "Review {{args}}.",
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets project Gemini agent settings override home settings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ace-gemini-settings-precedence-"));
    const geminiHome = path.join(root, "gemini-home");
    const cwd = path.join(root, "repo");
    try {
      await mkdir(path.join(geminiHome), { recursive: true });
      await mkdir(path.join(cwd, ".gemini"), { recursive: true });
      await writeFile(
        path.join(geminiHome, "settings.json"),
        JSON.stringify({
          agents: {
            overrides: {
              browser_agent: { enabled: true },
            },
          },
        }),
      );
      await writeFile(
        path.join(cwd, ".gemini", "settings.json"),
        JSON.stringify({
          agents: {
            overrides: {
              browser_agent: { enabled: false },
            },
          },
        }),
      );

      const commands = withProviderExtensionSlashCommands({
        providers: [
          {
            provider: "gemini",
            enabled: true,
            installed: true,
            version: "1.0.0",
            minimumVersion: null,
            versionStatus: "ok",
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-01-01T00:00:00.000Z",
            models: [],
          },
        ],
        cwd,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            gemini: {
              ...DEFAULT_SERVER_SETTINGS.providers.gemini,
              configDir: geminiHome,
            },
          },
        },
      })[0]?.commands;

      expect(findCommand(commands ?? [], "browser_agent")).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves Gemini agent override runtime metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ace-gemini-agent-overrides-"));
    const geminiHome = path.join(root, "gemini-home");
    const cwd = path.join(root, "repo");
    try {
      await mkdir(path.join(geminiHome), { recursive: true });
      await mkdir(path.join(cwd, ".gemini", "agents"), { recursive: true });
      await writeFile(
        path.join(cwd, ".gemini", "agents", "security-auditor.md"),
        [
          "---",
          "name: security-auditor",
          "description: Find security defects",
          "kind: local",
          "---",
          "",
          "# Agent prompt",
        ].join("\n"),
      );
      await writeFile(
        path.join(geminiHome, "settings.json"),
        JSON.stringify({
          agents: {
            overrides: {
              browser_agent: {
                enabled: true,
                modelConfig: {
                  model: "gemini-3-flash-preview",
                  temperature: "0.1",
                },
                runConfig: {
                  maxTurns: "6",
                  timeoutMins: 3,
                  tools: ["browser", "read_file"],
                },
              },
              "security-auditor": {
                modelConfig: {
                  model: "gemini-3-pro-preview",
                  topP: 0.8,
                },
              },
            },
          },
        }),
      );
      await mkdir(path.join(cwd, ".gemini"), { recursive: true });
      await writeFile(
        path.join(cwd, ".gemini", "settings.json"),
        JSON.stringify({
          agents: {
            overrides: {
              "security-auditor": {
                modelConfig: {
                  model: "gemini-3-flash-preview",
                },
                runConfig: {
                  max_turns: 10,
                },
              },
            },
          },
        }),
      );

      const commands = withProviderExtensionSlashCommands({
        providers: [
          {
            provider: "gemini",
            enabled: true,
            installed: true,
            version: "1.0.0",
            minimumVersion: null,
            versionStatus: "ok",
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-01-01T00:00:00.000Z",
            models: [],
          },
        ],
        cwd,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            gemini: {
              ...DEFAULT_SERVER_SETTINGS.providers.gemini,
              configDir: geminiHome,
            },
          },
        },
      })[0]?.commands;

      expect(findCommand(commands ?? [], "browser_agent")).toMatchObject({
        metadata: {
          provider: "gemini",
          source: "built-in-subagent",
          settingsOverride: true,
          enabled: true,
          model: "gemini-3-flash-preview",
          temperature: 0.1,
          maxTurns: 6,
          timeoutMins: 3,
          tools: ["browser", "read_file"],
        },
      });
      expect(findCommand(commands ?? [], "security-auditor")).toMatchObject({
        metadata: {
          provider: "gemini",
          source: "agent",
          kind: "local",
          settingsOverride: true,
          model: "gemini-3-flash-preview",
          topP: 0.8,
          maxTurns: 10,
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets nearest Gemini workspace settings override parent workspace settings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ace-gemini-nested-settings-precedence-"));
    const geminiHome = path.join(root, "gemini-home");
    const repo = path.join(root, "repo");
    const cwd = path.join(repo, "packages", "web");
    try {
      await mkdir(geminiHome, { recursive: true });
      await mkdir(path.join(repo, ".git"), { recursive: true });
      await mkdir(path.join(repo, ".gemini"), { recursive: true });
      await mkdir(path.join(cwd, ".gemini"), { recursive: true });
      await writeFile(
        path.join(repo, ".gemini", "settings.json"),
        JSON.stringify({
          agents: {
            overrides: {
              browser_agent: { enabled: true },
            },
          },
        }),
      );
      await writeFile(
        path.join(cwd, ".gemini", "settings.json"),
        JSON.stringify({
          agents: {
            overrides: {
              browser_agent: { enabled: false },
            },
          },
        }),
      );

      const commands = withProviderExtensionSlashCommands({
        providers: [
          {
            provider: "gemini",
            enabled: true,
            installed: true,
            version: "1.0.0",
            minimumVersion: null,
            versionStatus: "ok",
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-01-01T00:00:00.000Z",
            models: [],
          },
        ],
        cwd,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            gemini: {
              ...DEFAULT_SERVER_SETTINGS.providers.gemini,
              configDir: geminiHome,
            },
          },
        },
      })[0]?.commands;

      expect(findCommand(commands ?? [], "browser_agent")).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers Pi skills and prompt templates from current documented locations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ace-pi-extension-commands-"));
    const repo = path.join(root, "repo");
    const cwd = path.join(repo, "packages", "web");
    const piAgentDir = path.join(root, ".pi", "agent");
    const agentsHome = path.join(root, ".agents");
    try {
      await mkdir(path.join(repo, ".git"), { recursive: true });
      await writeSkill(path.join(repo, ".pi", "skills"), "deploy", "Project Pi deploy skill");
      await writeMarkdownSkill(
        path.join(repo, ".pi", "skills"),
        "audit.md",
        "audit",
        "Project Markdown audit skill",
        ["argument-hint: <scope>"],
      );
      await writeAgentMarkdown({
        root: path.join(repo, ".pi", "agents"),
        fileName: "architect.md",
        name: "architect",
        description: "Project Pi architect agent",
      });
      await writeFile(
        path.join(repo, ".pi", "agents", "scout.md"),
        [
          "---",
          "name: scout",
          "package: code-analysis",
          "description: Packaged Pi scout agent",
          "model: openai/gpt-5.4-mini",
          "thinking: high",
          "tools: [read_file, grep]",
          "agents: [reviewer, worker]",
          "---",
          "",
          "Scout code with package-scoped identity.",
        ].join("\n"),
      );
      await writeFile(
        path.join(repo, ".pi", "agents", "review-loop.chain.md"),
        "---\nname: review-loop\ndescription: Pi chain, not an agent\n---\n\nRun reviewer then worker.",
      );
      await writeAgentMarkdown({
        root: path.join(repo, ".agents"),
        fileName: "legacy-reviewer.md",
        name: "legacy-reviewer",
        description: "Legacy shared Pi reviewer agent",
      });
      await writeMarkdownSkill(path.join(repo, ".pi", "skills"), "ignored.md", "ignored");
      await writeSkill(path.join(cwd, ".agents", "skills"), "designx", "Nested shared skill");
      await writeSkill(path.join(piAgentDir, "skills"), "deploy", "Global Pi deploy skill");
      await writeAgentMarkdown({
        root: path.join(piAgentDir, "agents"),
        fileName: "global-planner.md",
        name: "global-planner",
        description: "Global Pi planner agent",
      });
      await writeAgentMarkdown({
        root: path.join(piAgentDir, "extensions", "subagent", "agents"),
        fileName: "extension-scout.md",
        name: "extension-scout",
        description: "Installed Pi extension scout agent",
      });
      await writeMarkdownSkill(
        path.join(piAgentDir, "skills"),
        "transcribe.md",
        "transcribe",
        "Global Markdown transcribe skill",
      );
      await writeSkill(path.join(agentsHome, "skills"), "frontend-design", "Shared global skill");
      await writePiPrompt(
        path.join(repo, ".pi", "prompts"),
        "plan.md",
        "---\ndescription: Plan the current task\nargument-hint: <task>\n---\n\nPlan $ARGUMENTS.",
      );
      await writePiPrompt(
        path.join(repo, ".pi", "prompts", "workflows"),
        "release.md",
        "# Nested release\n\nThis should only load when explicitly referenced.",
      );
      await writePiPrompt(
        path.join(repo, ".pi", "prompts", "workflows"),
        "unlisted.md",
        "# Unlisted nested prompt\n\nPrompt directory discovery is non-recursive.",
      );
      await writePiPrompt(
        path.join(piAgentDir, "prompts"),
        "status.md",
        "# Status report\n\nSummarize status for $ARGUMENTS.",
      );
      await writePiPrompt(
        path.join(repo, ".pi", "package-prompts"),
        "retro.md",
        "---\ndescription: Run a package retro\n---\n\nRun a retro for $ARGUMENTS.",
      );
      await writeSkill(
        path.join(repo, ".pi", "package-skills"),
        "incident",
        "Package incident skill",
      );
      await writeAgentMarkdown({
        root: path.join(repo, ".pi", "package-agents"),
        fileName: "package-reviewer.md",
        name: "package-reviewer",
        description: "Package Pi reviewer agent",
      });
      await writeFile(
        path.join(repo, "package.json"),
        JSON.stringify({
          name: "repo-package",
          pi: {
            prompts: [".pi/package-prompts/retro.md", ".pi/prompts/workflows/release.md"],
            skills: [".pi/package-skills/incident"],
            agents: [".pi/package-agents/package-reviewer.md"],
          },
        }),
      );
      await writePiPrompt(
        path.join(repo, ".pi", "settings-prompts"),
        "standup.md",
        "# Standup\n\nDraft standup notes for $ARGUMENTS.",
      );
      await writeMarkdownSkill(
        path.join(repo, ".pi", "settings-skills"),
        "ops.md",
        "ops",
        "Settings ops skill",
      );
      await writeAgentMarkdown({
        root: path.join(repo, ".pi", "settings-agents"),
        fileName: "settings-oracle.md",
        name: "settings-oracle",
        description: "Settings Pi oracle agent",
      });
      const localPackageRoot = path.join(repo, ".pi", "packages", "team-tools");
      await writePiPrompt(
        path.join(localPackageRoot, "prompts"),
        "triage.md",
        "---\ndescription: Triage through local package\n---\n\nTriage $ARGUMENTS.",
      );
      await writeSkill(path.join(localPackageRoot, "skills"), "handoff", "Local package handoff");
      await writeAgentMarkdown({
        root: path.join(localPackageRoot, "agents"),
        fileName: "package-worker.md",
        name: "package-worker",
        description: "Local package worker agent",
      });
      await mkdir(localPackageRoot, { recursive: true });
      await writeFile(
        path.join(localPackageRoot, "package.json"),
        JSON.stringify({
          name: "team-tools",
          keywords: ["pi-package"],
        }),
      );
      const filteredPackageRoot = path.join(repo, ".pi", "packages", "filtered-tools");
      await writePiPrompt(
        path.join(filteredPackageRoot, "prompts"),
        "included.md",
        "---\ndescription: Included filtered package prompt\n---\n\nRun included prompt.",
      );
      await writePiPrompt(
        path.join(filteredPackageRoot, "prompts"),
        "excluded.md",
        "---\ndescription: Excluded filtered package prompt\n---\n\nRun excluded prompt.",
      );
      await writeSkill(
        path.join(filteredPackageRoot, "skills"),
        "filtered-skill",
        "Filtered package skill",
      );
      await writeAgentMarkdown({
        root: path.join(filteredPackageRoot, "agents"),
        fileName: "filtered-agent.md",
        name: "filtered-agent",
        description: "Filtered package agent",
      });
      await mkdir(filteredPackageRoot, { recursive: true });
      await writeFile(
        path.join(filteredPackageRoot, "package.json"),
        JSON.stringify({
          name: "filtered-tools",
          keywords: ["pi-package"],
          pi: {
            prompts: ["./prompts"],
            skills: ["./skills"],
            agents: ["./agents"],
          },
        }),
      );
      const extensionOnlyPackageRoot = path.join(repo, ".pi", "packages", "extension-only");
      await writePiPrompt(
        path.join(extensionOnlyPackageRoot, "prompts"),
        "extension-hidden-prompt.md",
        "---\ndescription: Hidden by extension-only package filter\n---\n\nDo not expose.",
      );
      await writeSkill(
        path.join(extensionOnlyPackageRoot, "skills"),
        "extension-hidden-skill",
        "Hidden extension-only package skill",
      );
      await writeAgentMarkdown({
        root: path.join(extensionOnlyPackageRoot, "agents"),
        fileName: "extension-hidden-agent.md",
        name: "extension-hidden-agent",
        description: "Hidden extension-only package agent",
      });
      await mkdir(extensionOnlyPackageRoot, { recursive: true });
      await writeFile(
        path.join(extensionOnlyPackageRoot, "package.json"),
        JSON.stringify({
          name: "extension-only",
          keywords: ["pi-package"],
        }),
      );
      await mkdir(path.join(repo, ".pi"), { recursive: true });
      await writeFile(
        path.join(repo, ".pi", "settings.json"),
        JSON.stringify({
          prompts: ["./settings-prompts/standup.md"],
          skills: ["./settings-skills/ops.md"],
          agents: ["./settings-agents/settings-oracle.md"],
          packages: [
            { source: "./packages/team-tools" },
            {
              source: "./packages/filtered-tools",
              prompts: ["./prompts/included.md"],
              skills: [],
              agents: [],
            },
            {
              source: "./packages/extension-only",
              extensions: ["./extensions/index.ts"],
            },
          ],
        }),
      );
      await writePiPrompt(
        path.join(piAgentDir, "global-prompts"),
        "brief.md",
        "---\ndescription: Global settings brief\n---\n\nBrief $ARGUMENTS.",
      );
      await mkdir(piAgentDir, { recursive: true });
      await writeFile(
        path.join(piAgentDir, "settings.json"),
        JSON.stringify({
          prompts: ["./global-prompts/brief.md"],
          subagents: {
            agentOverrides: {
              oracle: { disabled: true },
            },
          },
        }),
      );

      const commands = discoverPiExtensionSlashCommands({
        cwd,
        agentDir: piAgentDir,
        agentsHome,
      });

      expect(commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "skill:deploy",
            kind: "skill",
            promptPrefix: "/skill:deploy",
            description: "Project Pi deploy skill",
          }),
          expect.objectContaining({
            name: "skill:audit",
            kind: "skill",
            promptPrefix: "/skill:audit",
            description: "Project Markdown audit skill",
            inputHint: "<scope>",
          }),
          expect.objectContaining({
            name: "skill:designx",
            kind: "skill",
            promptPrefix: "/skill:designx",
            description: "Nested shared skill",
          }),
          expect.objectContaining({
            name: "skill:transcribe",
            kind: "skill",
            promptPrefix: "/skill:transcribe",
            description: "Global Markdown transcribe skill",
          }),
          expect.objectContaining({
            name: "skill:frontend-design",
            kind: "skill",
            promptPrefix: "/skill:frontend-design",
            description: "Shared global skill",
          }),
          expect.objectContaining({
            name: "architect",
            kind: "agent",
            promptPrefix: "@architect",
            description: "Project Pi architect agent",
          }),
          expect.objectContaining({
            name: "code-analysis.scout",
            kind: "agent",
            promptPrefix: "@code-analysis.scout",
            description: "Packaged Pi scout agent",
            metadata: {
              provider: "pi",
              source: "agent",
              package: "code-analysis",
              model: "openai/gpt-5.4-mini",
              thinking: "high",
              tools: ["read_file", "grep"],
              agents: ["reviewer", "worker"],
            },
          }),
          expect.objectContaining({
            name: "legacy-reviewer",
            kind: "agent",
            promptPrefix: "@legacy-reviewer",
            description: "Legacy shared Pi reviewer agent",
          }),
          expect.objectContaining({
            name: "global-planner",
            kind: "agent",
            promptPrefix: "@global-planner",
            description: "Global Pi planner agent",
          }),
          expect.objectContaining({
            name: "extension-scout",
            kind: "agent",
            promptPrefix: "@extension-scout",
            description: "Installed Pi extension scout agent",
          }),
          expect.objectContaining({
            name: "plan",
            kind: "provider",
            promptPrefix: "/plan",
            inputHint: "<task>",
            description: "Plan the current task",
          }),
          expect.objectContaining({
            name: "status",
            kind: "provider",
            promptPrefix: "/status",
            description: "Status report",
          }),
          expect.objectContaining({
            name: "retro",
            kind: "provider",
            promptPrefix: "/retro",
            description: "Run a package retro",
          }),
          expect.objectContaining({
            name: "release",
            kind: "provider",
            promptPrefix: "/release",
            description: "Nested release",
          }),
          expect.objectContaining({
            name: "standup",
            kind: "provider",
            promptPrefix: "/standup",
            description: "Standup",
          }),
          expect.objectContaining({
            name: "triage",
            kind: "provider",
            promptPrefix: "/triage",
            description: "Triage through local package",
          }),
          expect.objectContaining({
            name: "brief",
            kind: "provider",
            promptPrefix: "/brief",
            description: "Global settings brief",
          }),
          expect.objectContaining({
            name: "included",
            kind: "provider",
            promptPrefix: "/included",
            description: "Included filtered package prompt",
          }),
          expect.objectContaining({
            name: "skill:incident",
            kind: "skill",
            promptPrefix: "/skill:incident",
            description: "Package incident skill",
          }),
          expect.objectContaining({
            name: "skill:ops",
            kind: "skill",
            promptPrefix: "/skill:ops",
            description: "Settings ops skill",
          }),
          expect.objectContaining({
            name: "skill:handoff",
            kind: "skill",
            promptPrefix: "/skill:handoff",
            description: "Local package handoff",
          }),
          expect.objectContaining({
            name: "package-reviewer",
            kind: "agent",
            promptPrefix: "@package-reviewer",
            description: "Package Pi reviewer agent",
          }),
          expect.objectContaining({
            name: "settings-oracle",
            kind: "agent",
            promptPrefix: "@settings-oracle",
            description: "Settings Pi oracle agent",
          }),
          expect.objectContaining({
            name: "package-worker",
            kind: "agent",
            promptPrefix: "@package-worker",
            description: "Local package worker agent",
          }),
          expect.objectContaining({
            name: "scout",
            kind: "agent",
            promptPrefix: "@scout",
          }),
          expect.objectContaining({
            name: "verifier",
            kind: "agent",
            promptPrefix: "@verifier",
          }),
          expect.objectContaining({
            name: "security-auditor",
            kind: "agent",
            promptPrefix: "@security-auditor",
          }),
        ]),
      );
      expect(findCommand(commands, "skill:deploy")?.description).toBe("Project Pi deploy skill");
      expect(findCommand(commands, "oracle")).toBeUndefined();
      expect(findCommand(commands, "verifier")?.metadata).toEqual({
        provider: "pi",
        source: "built-in-subagent",
      });
      expect(findCommand(commands, "scout")?.description).not.toBe("Packaged Pi scout agent");
      expect(findCommand(commands, "review-loop")).toBeUndefined();
      expect(findCommand(commands, "skill:ignored")).toBeUndefined();
      expect(findCommand(commands, "deploy")).toBeUndefined();
      expect(findCommand(commands, "unlisted")).toBeUndefined();
      expect(findCommand(commands, "excluded")).toBeUndefined();
      expect(findCommand(commands, "skill:filtered-skill")).toBeUndefined();
      expect(findCommand(commands, "filtered-agent")).toBeUndefined();
      expect(findCommand(commands, "extension-hidden-prompt")).toBeUndefined();
      expect(findCommand(commands, "skill:extension-hidden-skill")).toBeUndefined();
      expect(findCommand(commands, "extension-hidden-agent")).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("respects Pi enableSkillCommands settings without hiding prompts or agents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ace-pi-skill-command-settings-"));
    const repo = path.join(root, "repo");
    const cwd = path.join(repo, "packages", "web");
    const piAgentDir = path.join(root, ".pi-agent");
    try {
      await mkdir(path.join(repo, ".git"), { recursive: true });
      await mkdir(cwd, { recursive: true });
      await writeSkill(path.join(repo, ".pi", "skills"), "deploy", "Deploy through Pi skill");
      await writePiPrompt(
        path.join(repo, ".pi", "prompts"),
        "status.md",
        "# Status\n\nSummarize current state.",
      );
      await writeAgentMarkdown({
        root: path.join(repo, ".pi", "agents"),
        fileName: "reviewer.md",
        name: "reviewer",
        description: "Review with Pi agent",
      });
      await mkdir(piAgentDir, { recursive: true });
      await writeFile(
        path.join(piAgentDir, "settings.json"),
        JSON.stringify({ enableSkillCommands: false }),
      );

      const globallyDisabled = discoverPiExtensionSlashCommands({
        cwd,
        agentDir: piAgentDir,
      });
      expect(findCommand(globallyDisabled, "skill:deploy")).toBeUndefined();
      expect(findCommand(globallyDisabled, "status")).toEqual(
        expect.objectContaining({ kind: "provider" }),
      );
      expect(findCommand(globallyDisabled, "reviewer")).toEqual(
        expect.objectContaining({ kind: "agent" }),
      );

      await mkdir(path.join(repo, ".pi"), { recursive: true });
      await writeFile(
        path.join(repo, ".pi", "settings.json"),
        JSON.stringify({ enableSkillCommands: true }),
      );

      expect(
        findCommand(
          discoverPiExtensionSlashCommands({
            cwd,
            agentDir: piAgentDir,
          }),
          "skill:deploy",
        ),
      ).toEqual(expect.objectContaining({ kind: "skill" }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers Cursor project and global Markdown commands", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ace-cursor-extension-commands-"));
    const repo = path.join(root, "repo");
    const cwd = path.join(repo, "packages", "web");
    const cursorHome = path.join(root, ".cursor-home");
    try {
      await mkdir(path.join(repo, ".git"), { recursive: true });
      await mkdir(cwd, { recursive: true });
      await writeFile(
        path.join(repo, "AGENTS.md"),
        "# Cursor Agents\n\nUse repository-wide Cursor agent instructions.",
      );
      await writeFile(
        path.join(repo, ".cursorrules"),
        "# Legacy Cursor Rules\n\nUse legacy Cursor project rules.",
      );
      await writeFile(
        path.join(repo, "CLAUDE.md"),
        "# Cursor Claude Compatibility\n\nUse Claude-compatible Cursor CLI rules.",
      );
      await writeCursorCommand(
        path.join(repo, ".cursor", "commands"),
        "security-audit.md",
        "# Security Audit\n\nReview the code for security risks.",
      );
      await writeCursorCommand(
        path.join(repo, ".cursor", "commands"),
        "create-pr.md",
        "---\ndescription: Draft a pull request\n---\n\nWrite a pull request summary.",
      );
      await mkdir(path.join(repo, ".cursor", "commands", "git"), { recursive: true });
      await writeCursorCommand(
        path.join(repo, ".cursor", "commands", "git"),
        "commit.md",
        "---\ndescription: Draft a commit message\n---\n\nWrite a commit message.",
      );
      await writeCursorCommand(
        path.join(cursorHome, "commands"),
        "security-audit.md",
        "# Global Security Audit\n\nGlobal fallback should lose to project command.",
      );
      await writeCursorCommand(
        path.join(cursorHome, "commands"),
        "release-notes.md",
        "# Release Notes\n\nWrite release notes from the current diff.",
      );
      await writeAgentMarkdown({
        root: path.join(repo, ".cursor", "agents"),
        fileName: "security-auditor.md",
        name: "security-auditor",
        description: "Security specialist. Use when auth or payments change.",
        model: "composer-2",
      });
      await writeFile(
        path.join(repo, ".cursor", "agents", "background-verifier.md"),
        [
          "---",
          "name: background-verifier",
          "description: Verify completed work in the background.",
          "model: inherit",
          "read_only: true",
          "is_background: true",
          "---",
          "",
          "Verify changes and report results.",
        ].join("\n"),
      );
      await writeFile(
        path.join(repo, ".cursor", "agents", "background-planner.md"),
        [
          "---",
          "name: background-planner",
          "description: Plan work in the background.",
          "model: composer-2",
          "readOnly: true",
          "isBackground: true",
          "---",
          "",
          "Plan changes and report the recommended approach.",
        ].join("\n"),
      );
      await writeAgentMarkdown({
        root: path.join(repo, ".claude", "agents"),
        fileName: "security-auditor.md",
        name: "security-auditor",
        description: "Claude compatibility duplicate should lose to Cursor.",
      });
      await writeAgentMarkdown({
        root: path.join(repo, ".codex", "agents"),
        fileName: "verifier.md",
        name: "verifier",
        description: "Codex compatibility verifier.",
      });
      await writeFile(
        path.join(repo, ".codex", "agents", "codex-toml-reviewer.toml"),
        [
          'name = "codex-toml-reviewer"',
          'description = "Codex TOML compatibility reviewer."',
          'developer_instructions = "Review code through the Codex agent schema."',
          'model = "gpt-5.4-mini"',
          'model_reasoning_effort = "medium"',
          'sandbox_mode = "read-only"',
        ].join("\n"),
      );
      await writeAgentMarkdown({
        root: path.join(cursorHome, "agents"),
        fileName: "release-reviewer.md",
        name: "release-reviewer",
        description: "Global release reviewer.",
      });
      await writeSkill(
        path.join(repo, ".cursor", "skills", "workflow"),
        "land-it",
        "Land a finished change.",
      );
      await writeSkill(
        path.join(repo, ".agents", "skills"),
        "shared-context",
        "Apply shared project context.",
      );
      await writeSkill(
        path.join(repo, ".claude", "skills"),
        "claude-compat",
        "Claude compatibility skill.",
      );
      await writeSkill(path.join(cursorHome, "skills"), "global-skill", "Global Cursor skill.");
      await mkdir(path.join(repo, ".cursor", "rules"), { recursive: true });
      await writeFile(
        path.join(repo, ".cursor", "rules", "architecture.mdc"),
        [
          "---",
          "description: Architecture project rule",
          "alwaysApply: false",
          "---",
          "",
          "# Architecture",
          "",
          "Use the project architecture conventions.",
        ].join("\n"),
      );
      await mkdir(path.join(cwd, ".cursor", "rules", "frontend"), { recursive: true });
      await writeFile(
        path.join(cwd, ".cursor", "rules", "frontend", "component.mdc"),
        [
          "---",
          "description: Component rule",
          "globs: ['**/*.tsx']",
          "---",
          "",
          "Use the component conventions.",
        ].join("\n"),
      );
      await mkdir(path.join(cwd, ".cursor", "rules", "backend"), { recursive: true });
      await writeFile(
        path.join(cwd, ".cursor", "rules", "backend", "component.mdc"),
        [
          "---",
          "description: Backend component rule",
          "---",
          "",
          "Use the backend component conventions.",
        ].join("\n"),
      );
      await mkdir(path.join(repo, "packages", "api", ".cursor", "rules"), { recursive: true });
      await writeFile(
        path.join(repo, "packages", "api", ".cursor", "rules", "backend.mdc"),
        [
          "---",
          "description: Backend package rule",
          "alwaysApply: false",
          "---",
          "",
          "Use the backend package conventions.",
        ].join("\n"),
      );
      await mkdir(path.join(cursorHome, "rules"), { recursive: true });
      await writeFile(
        path.join(cursorHome, "rules", "architecture.mdc"),
        "# Global architecture\n\nGlobal fallback should lose to project rule.",
      );
      await writeFile(
        path.join(cursorHome, "rules", "global-context.mdc"),
        "# Global Context\n\nUse global Cursor context.",
      );

      const commands = discoverCursorExtensionSlashCommands({
        cwd,
        configDir: cursorHome,
      });

      expect(commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "security-audit",
            kind: "plugin",
            promptPrefix: "# Security Audit\n\nReview the code for security risks.",
            description: "Security Audit",
            metadata: {
              provider: "cursor",
              source: "command",
            },
          }),
          expect.objectContaining({
            name: "create-pr",
            kind: "plugin",
            promptPrefix: "Write a pull request summary.",
            description: "Draft a pull request",
          }),
          expect.objectContaining({
            name: "git:commit",
            kind: "plugin",
            promptPrefix: "Write a commit message.",
            description: "Draft a commit message",
          }),
          expect.objectContaining({
            name: "release-notes",
            kind: "plugin",
            promptPrefix: "# Release Notes\n\nWrite release notes from the current diff.",
            description: "Release Notes",
          }),
          expect.objectContaining({
            name: "security-auditor",
            kind: "agent",
            promptPrefix: "/security-auditor",
            description: "Security specialist. Use when auth or payments change.",
            metadata: {
              provider: "cursor",
              source: "agent",
              model: "composer-2",
            },
          }),
          expect.objectContaining({
            name: "background-verifier",
            kind: "agent",
            promptPrefix: "/background-verifier",
            description: "Verify completed work in the background.",
            metadata: {
              provider: "cursor",
              source: "agent",
              model: "inherit",
              readOnly: true,
              isBackground: true,
            },
          }),
          expect.objectContaining({
            name: "background-planner",
            kind: "agent",
            promptPrefix: "/background-planner",
            description: "Plan work in the background.",
            metadata: {
              provider: "cursor",
              source: "agent",
              model: "composer-2",
              readOnly: true,
              isBackground: true,
            },
          }),
          expect.objectContaining({
            name: "verifier",
            kind: "agent",
            promptPrefix: "/verifier",
            description: "Codex compatibility verifier.",
          }),
          expect.objectContaining({
            name: "codex-toml-reviewer",
            kind: "agent",
            promptPrefix: "/codex-toml-reviewer",
            description: "Codex TOML compatibility reviewer.",
            metadata: {
              provider: "cursor",
              source: "agent",
              format: "codex-agent-toml",
              model: "gpt-5.4-mini",
              modelReasoningEffort: "medium",
              sandboxMode: "read-only",
            },
          }),
          expect.objectContaining({
            name: "release-reviewer",
            kind: "agent",
            promptPrefix: "/release-reviewer",
            description: "Global release reviewer.",
          }),
          expect.objectContaining({
            name: "explore",
            kind: "agent",
            promptPrefix: "/explore",
            description: "Run Cursor's built-in codebase search subagent.",
          }),
          expect.objectContaining({
            name: "bash",
            kind: "agent",
            promptPrefix: "/bash",
            description: "Run Cursor's built-in shell command subagent.",
          }),
          expect.objectContaining({
            name: "browser",
            kind: "agent",
            promptPrefix: "/browser",
            description: "Run Cursor's built-in browser automation subagent.",
          }),
          expect.objectContaining({
            name: "land-it",
            kind: "skill",
            promptPrefix: "/land-it",
            description: "Land a finished change.",
          }),
          expect.objectContaining({
            name: "shared-context",
            kind: "skill",
            promptPrefix: "/shared-context",
            description: "Apply shared project context.",
          }),
          expect.objectContaining({
            name: "claude-compat",
            kind: "skill",
            promptPrefix: "/claude-compat",
            description: "Claude compatibility skill.",
          }),
          expect.objectContaining({
            name: "global-skill",
            kind: "skill",
            promptPrefix: "/global-skill",
            description: "Global Cursor skill.",
          }),
          expect.objectContaining({
            name: "rule:architecture",
            kind: "skill",
            promptPrefix: "@architecture",
            description: "Architecture project rule",
            metadata: {
              provider: "cursor",
              source: "rule",
              alwaysApply: false,
            },
          }),
          expect.objectContaining({
            name: "rule:frontend-component",
            kind: "skill",
            promptPrefix: "@frontend-component",
            description: "Component rule",
            metadata: {
              provider: "cursor",
              source: "rule",
              globs: "**/*.tsx",
            },
          }),
          expect.objectContaining({
            name: "rule:backend-component",
            kind: "skill",
            promptPrefix: "@backend-component",
            description: "Backend component rule",
          }),
          expect.objectContaining({
            name: "rule:backend",
            kind: "skill",
            promptPrefix: "@backend",
            description: "Backend package rule",
          }),
          expect.objectContaining({
            name: "rule:global-context",
            kind: "skill",
            promptPrefix: "@global-context",
            description: "Global Context",
          }),
          expect.objectContaining({
            name: "rule:agents",
            kind: "skill",
            promptPrefix: "# Cursor Agents\n\nUse repository-wide Cursor agent instructions.",
            description: "Cursor Agents",
            metadata: {
              provider: "cursor",
              source: "rule",
            },
          }),
          expect.objectContaining({
            name: "rule:cursorrules",
            kind: "skill",
            promptPrefix: "# Legacy Cursor Rules\n\nUse legacy Cursor project rules.",
            description: "Legacy Cursor Rules",
          }),
          expect.objectContaining({
            name: "rule:claude",
            kind: "skill",
            promptPrefix:
              "# Cursor Claude Compatibility\n\nUse Claude-compatible Cursor CLI rules.",
            description: "Cursor Claude Compatibility",
          }),
        ]),
      );
      expect(findCommand(commands, "security-audit")?.promptPrefix).toBe(
        "# Security Audit\n\nReview the code for security risks.",
      );
      expect(findCommand(commands, "security-auditor")?.description).toBe(
        "Security specialist. Use when auth or payments change.",
      );
      expect(findCommand(commands, "rule:architecture")?.description).toBe(
        "Architecture project rule",
      );

      const providerCommands = withProviderExtensionSlashCommands({
        providers: [
          {
            provider: "cursor",
            enabled: true,
            installed: true,
            version: "1.0.0",
            minimumVersion: null,
            versionStatus: "ok",
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-01-01T00:00:00.000Z",
            models: [],
          },
        ],
        cwd,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            cursor: {
              ...DEFAULT_SERVER_SETTINGS.providers.cursor,
              configDir: cursorHome,
            },
          },
        },
      })[0]?.commands;

      expect(providerCommands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "create-pr",
            kind: "plugin",
            promptPrefix: "Write a pull request summary.",
          }),
          expect.objectContaining({
            name: "git:commit",
            kind: "plugin",
            promptPrefix: "Write a commit message.",
          }),
          expect.objectContaining({
            name: "release-notes",
            kind: "plugin",
            promptPrefix: "# Release Notes\n\nWrite release notes from the current diff.",
          }),
          expect.objectContaining({
            name: "security-auditor",
            kind: "agent",
            promptPrefix: "/security-auditor",
          }),
          expect.objectContaining({
            name: "land-it",
            kind: "skill",
            promptPrefix: "/land-it",
          }),
          expect.objectContaining({
            name: "rule:architecture",
            kind: "skill",
            promptPrefix: "@architecture",
          }),
          expect.objectContaining({
            name: "rule:frontend-component",
            kind: "skill",
            promptPrefix: "@frontend-component",
          }),
          expect.objectContaining({
            name: "rule:backend-component",
            kind: "skill",
            promptPrefix: "@backend-component",
          }),
          expect.objectContaining({
            name: "rule:agents",
            kind: "skill",
            promptPrefix: "# Cursor Agents\n\nUse repository-wide Cursor agent instructions.",
          }),
          expect.objectContaining({
            name: "rule:cursorrules",
            kind: "skill",
            promptPrefix: "# Legacy Cursor Rules\n\nUse legacy Cursor project rules.",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers GitHub Copilot and OpenCode agent profiles", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ace-provider-agent-commands-"));
    const cwd = path.join(root, "repo");
    const copilotHome = path.join(root, ".github-copilot-home");
    const opencodeHome = path.join(root, ".config", "opencode");
    const nestedCwd = path.join(cwd, "packages", "app");
    try {
      await mkdir(path.join(cwd, ".git"), { recursive: true });
      await mkdir(nestedCwd, { recursive: true });
      await mkdir(path.join(nestedCwd, ".vscode"), { recursive: true });
      await writeFile(
        path.join(nestedCwd, ".vscode", "settings.json"),
        JSON.stringify({
          "chat.useCustomizationsInParentRepositories": true,
        }),
      );
      await writeFile(
        path.join(cwd, "AGENTS.md"),
        "# Repository Agents\n\nUse repository-wide agent instructions.",
      );
      await writeFile(
        path.join(nestedCwd, "AGENTS.md"),
        "# Package Agents\n\nUse package-local agent instructions.",
      );
      await writeFile(path.join(cwd, "CLAUDE.md"), "# Claude Compatibility\n\nUse Claude rules.");
      await writeFile(path.join(cwd, "GEMINI.md"), "# Gemini Compatibility\n\nUse Gemini rules.");
      await mkdir(path.join(cwd, ".github"), { recursive: true });
      await writeFile(
        path.join(cwd, ".github", "copilot-instructions.md"),
        [
          "---",
          "description: Repository Copilot instructions",
          "---",
          "",
          "Follow the repository Copilot workflow.",
        ].join("\n"),
      );
      await mkdir(path.join(cwd, ".vscode"), { recursive: true });
      await writeFile(
        path.join(cwd, ".vscode", "mcp.json"),
        JSON.stringify({
          servers: {
            fetch: {
              type: "stdio",
              command: "uvx",
              args: ["mcp-server-fetch"],
              tools: ["fetch"],
            },
            shared: {
              command: "vscode-shared-mcp",
              args: [],
            },
          },
        }),
      );
      await writeFile(
        path.join(cwd, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            shared: {
              type: "http",
              url: "https://workspace.example.test/mcp",
              headers: {
                "X-Workspace": "true",
              },
              tools: ["workspace_search"],
            },
          },
        }),
      );
      await writeFile(
        path.join(cwd, ".github", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            repo: {
              type: "sse",
              url: "https://repo.example.test/sse",
              tools: ["repo_search"],
            },
          },
        }),
      );
      await mkdir(copilotHome, { recursive: true });
      await writeFile(
        path.join(copilotHome, "mcp-config.json"),
        JSON.stringify({
          mcpServers: {
            personal: {
              command: "personal-mcp",
              args: ["--stdio"],
              env: {
                COPILOT_MCP_SCOPE: "personal",
              },
              tools: ["personal_read"],
            },
          },
        }),
      );
      await mkdir(path.join(cwd, ".github", "instructions", "ui"), { recursive: true });
      await writeFile(
        path.join(cwd, ".github", "instructions", "frontend.instructions.md"),
        [
          "---",
          "description: Frontend Copilot instructions",
          'applyTo: "apps/web/**"',
          "---",
          "",
          "Use frontend-specific Copilot conventions.",
        ].join("\n"),
      );
      await writeFile(
        path.join(cwd, ".github", "instructions", "ui", "accessibility.instructions.md"),
        [
          "---",
          "name: Accessibility instructions",
          'applyTo: "**/*.tsx"',
          "---",
          "",
          "Preserve accessible UI behavior.",
        ].join("\n"),
      );
      await writeAgentMarkdown({
        root: path.join(cwd, ".github", "agents"),
        fileName: "readme-creator.md",
        name: "readme-creator",
        description: "Create README files",
      });
      await writeAgentMarkdown({
        root: path.join(cwd, ".github", "agents"),
        fileName: "repo-auditor.agent.md",
        description: "Audit repository health",
      });
      await writeAgentMarkdown({
        root: path.join(cwd, ".github", "agents"),
        fileName: "workspace-helper.agents.md",
        description: "Modern plural-suffix Copilot custom agent",
      });
      await writeFile(
        path.join(cwd, ".github", "agents", "release-manager.agent.md"),
        [
          "---",
          "name: Release Manager",
          "description: Coordinates release readiness",
          "argument-hint: <release plan>",
          "agents: [security-auditor, programmatic-researcher]",
          "model: [Claude Opus 4.5, GPT-5.2]",
          "metadata:",
          "  team: Release Engineering",
          "  workflow: release-readiness",
          "  ignoredNumber: 42",
          "handoffs:",
          "  - label: Implement Release Plan",
          "    agent: agent",
          "    prompt: Implement the release plan.",
          "    send: false",
          "    model: GPT-5.2 (copilot)",
          "hooks:",
          "  postToolUse:",
          "    - type: command",
          "      command: ./scripts/format-changed-files.sh",
          "      timeout: 15",
          "skills:",
          "  - release-review",
          "  - migration-audit",
          "tools: [read_file, grep]",
          "infer: false",
          "---",
          "",
          "Plan and verify release readiness.",
        ].join("\n"),
      );
      await writeAgentMarkdown({
        root: path.join(cwd, ".github", "agents"),
        fileName: "explore.agent.md",
        description: "Project explore override",
      });
      await writeFile(
        path.join(cwd, ".github", "agents", "programmatic-researcher.agent.md"),
        [
          "---",
          "description: Researches implementation context programmatically",
          "target: github-copilot",
          "tools: []",
          "disable-model-invocation: true",
          "user-invocable: false",
          'mcp-servers: {"local-docs":{"type":"stdio","command":"docs-mcp","args":["--stdio"],"tools":["search"],"env":{"DOCS_MODE":"local"}}}',
          "---",
          "",
          "Research implementation details without direct user invocation.",
        ].join("\n"),
      );
      await writeFile(
        path.join(cwd, ".github", "agents", "mcp-specialist.agent.md"),
        [
          "---",
          "description: Uses an agent-scoped MCP server",
          "target: github-copilot",
          "tools: ['read', 'custom-mcp/tool-1']",
          "mcp-servers:",
          "  custom-mcp:",
          "    type: local",
          "    command: some-command",
          "    args:",
          "      - --arg1",
          "      - --arg2",
          "    tools: ['*']",
          "    timeout: 30",
          "    env:",
          "      ENV_VAR_NAME: ${{ secrets.COPILOT_MCP_ENV_VAR_VALUE }}",
          "---",
          "",
          "Use the custom MCP server for specialist research.",
        ].join("\n"),
      );
      await writeFile(
        path.join(cwd, ".github", "agents", "mcp-list-specialist.agent.md"),
        [
          "---",
          "description: Uses list-form MCP server config",
          "target: github-copilot",
          'mcp-servers: [{"name":"list-docs","type":"http","url":"https://list.example.test/mcp","tools":["search","read"],"headers":{"X-List":"true"}},{"servers":{"nested-local":{"type":"stdio","command":"nested-mcp","args":["--stdio"],"tools":["nested_search"]}}}]',
          "---",
          "",
          "Use list-form MCP server configuration for specialist research.",
        ].join("\n"),
      );
      await writeFile(
        path.join(cwd, ".github", "agents", "automatic-specialist.agent.md"),
        [
          "---",
          "description: Allows automatic model invocation using the current Copilot field",
          "target: github-copilot",
          "disable-model-invocation: false",
          "infer: false",
          "---",
          "",
          "Use this agent automatically when its specialty applies.",
        ].join("\n"),
      );
      await writeFile(
        path.join(cwd, ".github", "agents", "target-list-specialist.agent.md"),
        [
          "---",
          "description: Uses block-list target and current field aliases",
          "target:",
          "  - github-copilot",
          "argumentHint: <topic>",
          "disableModelInvocation: true",
          "userInvocable: true",
          "---",
          "",
          "Handle target-list Copilot agent tasks.",
        ].join("\n"),
      );
      await writeFile(
        path.join(cwd, ".github", "agents", "snake-target-specialist.agent.md"),
        [
          "---",
          "description: Uses snake-case agent field aliases",
          "targets: [github-copilot]",
          "argument_hint: <subject>",
          "disable_model_invocation: false",
          "user_invocable: true",
          "---",
          "",
          "Handle snake-case Copilot agent tasks.",
        ].join("\n"),
      );
      await writeFile(
        path.join(cwd, ".github", "agents", "missing-description.agent.md"),
        [
          "---",
          "name: Missing Description",
          "target: github-copilot",
          "---",
          "",
          "This malformed custom agent is missing GitHub Copilot's required description.",
        ].join("\n"),
      );
      await writeFile(
        path.join(cwd, ".github", "agents", "vscode-only.agent.md"),
        [
          "---",
          "description: VS Code only agent",
          "target: vscode",
          "---",
          "",
          "Only load in VS Code.",
        ].join("\n"),
      );
      await writeFile(
        path.join(cwd, ".github", "agents", "zed-only.agent.md"),
        ["---", "description: Zed only agent", "target: zed", "---", "", "Only load in Zed."].join(
          "\n",
        ),
      );
      await writeAgentMarkdown({
        root: path.join(cwd, ".github", "copilot", "agents"),
        fileName: "configured.agent.md",
        description: "Configured Copilot agent root",
      });
      await writeAgentMarkdown({
        root: path.join(cwd, "workflow-agents", "nested"),
        fileName: "workflow.agent.md",
        description: "Workflow configured agent",
      });
      await writeAgentMarkdown({
        root: path.join(cwd, "disabled-agents"),
        fileName: "ignored.agent.md",
        description: "Disabled configured agent",
      });
      await writeAgentMarkdown({
        root: path.join(cwd, ".github", "chatmodes"),
        fileName: "planning.chatmode.md",
        description: "Plan work before implementation",
      });
      await writeAgentMarkdown({
        root: path.join(cwd, ".claude", "agents"),
        fileName: "claude-format.agent.md",
        description: "Claude-format Copilot agent",
      });
      await mkdir(path.join(cwd, ".github", "prompts"), { recursive: true });
      await writeFile(
        path.join(cwd, ".github", "prompts", "release-review.prompt.md"),
        [
          "---",
          "name: release-ready",
          "description: Review release readiness",
          "argument-hint: <release>",
          "agent: plan",
          "model: GPT-5.2",
          "tools: [search/codebase]",
          "---",
          "",
          "Review release readiness for $ARGUMENTS.",
        ].join("\n"),
      );
      await writeFile(
        path.join(cwd, ".github", "prompts", "tooling.prompt.md"),
        [
          "---",
          "description: Run a tool-using prompt",
          "tools: [search/codebase, vscode/askQuestion]",
          "---",
          "",
          "Use tools to answer $ARGUMENTS.",
        ].join("\n"),
      );
      await mkdir(path.join(cwd, ".github", "copilot", "prompts"), { recursive: true });
      await writeFile(
        path.join(cwd, ".github", "copilot", "prompts", "configured.prompt.md"),
        "# Configured Prompt\n\nRun the configured prompt for $ARGUMENTS.",
      );
      await mkdir(path.join(cwd, "workflow-prompts", "nested"), { recursive: true });
      await writeFile(
        path.join(cwd, "workflow-prompts", "nested", "workflow.prompt.md"),
        "# Workflow Prompt\n\nRun the workflow prompt for $ARGUMENTS.",
      );
      await mkdir(path.join(cwd, "disabled-prompts"), { recursive: true });
      await writeFile(
        path.join(cwd, "disabled-prompts", "ignored.prompt.md"),
        "# Ignored Prompt\n\nThis disabled prompt should not be loaded.",
      );
      await mkdir(path.join(cwd, ".github", "copilot", "instructions"), { recursive: true });
      await writeFile(
        path.join(cwd, ".github", "copilot", "instructions", "configured.instructions.md"),
        [
          "---",
          "description: Configured instruction root",
          "---",
          "",
          "Use the configured Copilot instruction root.",
        ].join("\n"),
      );
      await mkdir(path.join(cwd, ".claude", "rules"), { recursive: true });
      await writeFile(
        path.join(cwd, ".claude", "rules", "workspace-style.instructions.md"),
        [
          "---",
          "description: Claude-format workspace rules",
          "---",
          "",
          "Use Claude-format workspace rules for Copilot.",
        ].join("\n"),
      );
      await mkdir(path.join(cwd, "workflow-instructions", "nested"), { recursive: true });
      await writeFile(
        path.join(cwd, "workflow-instructions", "nested", "workflow.instructions.md"),
        "# Workflow Instructions\n\nUse workflow-specific instructions.",
      );
      await mkdir(path.join(cwd, "disabled-instructions"), { recursive: true });
      await writeFile(
        path.join(cwd, "disabled-instructions", "ignored.instructions.md"),
        "# Ignored Instructions\n\nThis disabled instruction should not be loaded.",
      );
      await writeSkill(
        path.join(cwd, ".github", "copilot", "skills"),
        "configured-skill",
        "Configured Copilot skill root",
      );
      await writeSkill(
        path.join(cwd, "workflow-skills", "nested", "workflow-skill"),
        "workflow-skill",
        "Workflow configured skill",
      );
      await writeSkill(
        path.join(cwd, "disabled-skills"),
        "ignored-skill",
        "Disabled configured skill",
      );
      await mkdir(path.join(cwd, ".vscode"), { recursive: true });
      await writeFile(
        path.join(cwd, ".vscode", "settings.json"),
        [
          "{",
          "  // Copilot customization locations support workspace-relative paths.",
          '  "chat.useCustomAgentHooks": true,',
          '  "chat.agentFilesLocations": {',
          '    ".github/copilot/agents": true,',
          '    "workflow-agents/**/*.agent.md": true,',
          '    "disabled-agents": false,',
          "  },",
          '  "chat.promptFilesLocations": {',
          '    ".github/copilot/prompts": true,',
          '    "workflow-prompts/**/*.prompt.md": true,',
          '    "disabled-prompts": false,',
          "  },",
          '  "chat.instructionsFilesLocations": {',
          '    ".github/copilot/instructions": true,',
          '    "workflow-instructions/**/*.instructions.md": true,',
          '    "disabled-instructions": false,',
          "  },",
          '  "chat.agentSkillsLocations": {',
          '    ".github/copilot/skills": true,',
          '    "workflow-skills/**/SKILL.md": true,',
          '    "disabled-skills": false,',
          "  },",
          "}",
        ].join("\n"),
      );
      await mkdir(path.join(cwd, ".github", "prompts", "pull-request"), { recursive: true });
      await writeFile(
        path.join(cwd, ".github", "prompts", "pull-request", "summary.prompt.md"),
        "# PR Summary\n\nDraft a pull request summary for $ARGUMENTS.",
      );
      await writeAgentMarkdown({
        root: path.join(copilotHome, ".github-private", "agents"),
        fileName: "incident-reviewer.md",
        name: "incident-reviewer",
        description: "Review production incidents",
      });
      await writeAgentMarkdown({
        root: path.join(copilotHome, "agents"),
        fileName: "user-reviewer.agent.md",
        description: "Review user-level tasks",
      });
      await mkdir(path.join(copilotHome, "prompts"), { recursive: true });
      await writeFile(
        path.join(copilotHome, "prompts", "incident.prompt.md"),
        "# Incident prompt\n\nInvestigate the incident for $ARGUMENTS.",
      );
      await writeFile(
        path.join(copilotHome, "copilot-instructions.md"),
        "# Personal Copilot Instructions\n\nUse the user's personal Copilot preferences.",
      );
      await mkdir(path.join(copilotHome, "instructions"), { recursive: true });
      await writeFile(
        path.join(copilotHome, "instructions", "personal.instructions.md"),
        "# Personal File Instructions\n\nUse personal file-scoped instructions.",
      );
      await writeSkill(path.join(cwd, ".github", "skills"), "repo-skill", "Use repo skill");
      await writeSkill(
        path.join(cwd, ".claude", "skills"),
        "claude-compatible",
        "Use Claude-compatible Copilot skill",
      );
      await writeSkill(
        path.join(copilotHome, "skills"),
        "incident-review",
        "Review incident timelines",
      );
      await writeAgentMarkdown({
        root: path.join(cwd, ".opencode", "agents"),
        fileName: "review.md",
        description: "Review code quality",
        mode: "subagent",
        model: "anthropic/claude-sonnet-4-20250514",
        color: "accent",
        tools: ["read", "grep", "bash"],
        temperature: 0.2,
        maxSteps: 12,
        permission: {
          read: "allow",
          bash: {
            "git *": "ask",
            "rm *": "deny",
          },
          skill: {
            "docs-*": "allow",
          },
        },
        taskPermission: {
          "*": "deny",
          reviewer: "allow",
        },
      });
      await writeAgentMarkdown({
        root: path.join(cwd, ".opencode", "agents"),
        fileName: "research.md",
        description: "Research implementation options",
        mode: "all",
      });
      await writeAgentMarkdown({
        root: path.join(cwd, ".opencode", "agents"),
        fileName: "default-helper.md",
        description: "Default all-mode helper",
      });
      await writeFile(
        path.join(cwd, ".opencode", "agents", "missing-description.md"),
        "---\nmode: subagent\n---\n\n# Missing description\n",
      );
      await writeAgentMarkdown({
        root: path.join(cwd, ".opencode", "agents"),
        fileName: "disabled-helper.md",
        description: "Disabled helper",
        mode: "subagent",
        disable: true,
      });
      await writeAgentMarkdown({
        root: path.join(cwd, ".opencode", "agents"),
        fileName: "disabled-v2-helper.md",
        description: "Disabled helper using current OpenCode field",
        mode: "subagent",
        disabled: true,
      });
      await writeAgentMarkdown({
        root: path.join(cwd, ".opencode", "agent"),
        fileName: "legacy-scout.md",
        description: "Legacy singular agent path",
        mode: "subagent",
      });
      await writeFile(
        path.join(cwd, ".opencode", "agents", "internal.md"),
        "---\ndescription: Internal helper\nmode: subagent\nhidden: true\n---\n\n# Internal\n",
      );
      await writeAgentMarkdown({
        root: path.join(cwd, ".opencode", "agents"),
        fileName: "build.md",
        description: "Primary build agent",
        mode: "primary",
      });
      await mkdir(path.join(cwd, ".opencode", "commands"), { recursive: true });
      await writeFile(
        path.join(cwd, ".opencode", "commands", "test.md"),
        [
          "---",
          "description: Run project tests",
          "agent: build",
          "---",
          "",
          "Run tests for $ARGUMENTS and summarize failures.",
        ].join("\n"),
      );
      await writeFile(
        path.join(cwd, ".opencode", "commands", "analyze.md"),
        [
          "---",
          "description: Analyze without polluting primary context",
          "subtask: true",
          "---",
          "",
          "Analyze $ARGUMENTS in a subtask.",
        ].join("\n"),
      );
      await writeFile(
        path.join(cwd, ".opencode", "commands", "review-fast.md"),
        [
          "---",
          "description: Review through the markdown subagent",
          "agent: review",
          "model: opencode/gpt-5.1-codex",
          "---",
          "",
          "Review $ARGUMENTS without changing files.",
        ].join("\n"),
      );
      await writeFile(
        path.join(cwd, ".opencode", "commands", "scout-fast.md"),
        [
          "---",
          "description: Scout through the built-in subagent",
          "agent: ' Scout '",
          "---",
          "",
          "Research $ARGUMENTS with scout.",
        ].join("\n"),
      );
      await writeFile(
        path.join(cwd, ".opencode", "commands", "review-inline.md"),
        [
          "---",
          "description: Review in the primary context",
          "agent: review",
          "subtask: false",
          "---",
          "",
          "Review $ARGUMENTS inline.",
        ].join("\n"),
      );
      await writeFile(
        path.join(cwd, ".opencode", "commands", "disabled-fast.md"),
        [
          "---",
          "description: Try disabled markdown helper inline",
          "agent: disabled-helper",
          "---",
          "",
          "Run $ARGUMENTS without a disabled subagent.",
        ].join("\n"),
      );
      await writeFile(
        path.join(cwd, ".opencode", "commands", "internal-fast.md"),
        [
          "---",
          "description: Run hidden markdown subagent",
          "agent: internal",
          "---",
          "",
          "Use the hidden markdown subagent for $ARGUMENTS.",
        ].join("\n"),
      );
      await mkdir(path.join(cwd, ".opencode", "commands", "review"), { recursive: true });
      await writeFile(
        path.join(cwd, ".opencode", "commands", "review", "security.md"),
        [
          "---",
          "description: Review security in a nested OpenCode command",
          "agent: review",
          "---",
          "",
          "Review $ARGUMENTS for security issues.",
        ].join("\n"),
      );
      await mkdir(path.join(cwd, ".opencode", "command"), { recursive: true });
      await writeFile(
        path.join(cwd, ".opencode", "command", "legacy-review.md"),
        [
          "---",
          "description: Legacy singular command path",
          "agent: review",
          "---",
          "",
          "Review $ARGUMENTS from the singular command directory.",
        ].join("\n"),
      );
      await writeFile(
        path.join(cwd, "opencode.json"),
        JSON.stringify({
          command: {
            rootreview: {
              template: "Review repository state for $ARGUMENTS.",
              description: "Review from project root config",
            },
            rootdocs: {
              template: "Draft docs for $ARGUMENTS.",
              description: "Draft docs through a subagent",
              agent: "rootarchitect",
              model: "opencode/gpt-5.1-codex-mini",
            },
            rootplan: {
              template: "Plan $ARGUMENTS.",
              description: "Plan through primary build",
              agent: "build",
            },
            disableddocs: {
              template: "Draft disabled docs for $ARGUMENTS.",
              description: "Draft docs without disabled architect",
              agent: "disabledarchitect",
            },
            missingdescdocs: {
              template: "Draft docs for $ARGUMENTS.",
              description: "Draft docs without malformed architect",
              agent: "missingdescarchitect",
            },
            internaldocs: {
              template: "Draft hidden docs for $ARGUMENTS.",
              description: "Draft docs through hidden architect",
              agent: "internalarchitect",
            },
          },
          agent: {
            rootarchitect: {
              description: "Architect from project root config",
              mode: "subagent",
              model: "opencode/gpt-5.1-codex",
              color: "#4ade80",
              permission: {
                read: "allow",
                bash: {
                  "git *": "ask",
                  "rm *": "deny",
                },
                skill: {
                  "docs-*": "allow",
                },
                task: {
                  "*": "deny",
                  reviewer: "allow",
                },
              },
            },
            disabledarchitect: {
              description: "Disabled architect from project root config",
              mode: "subagent",
              disable: true,
            },
            missingdescarchitect: {
              mode: "subagent",
            },
            internalarchitect: {
              description: "Hidden architect from project root config",
              mode: "subagent",
              hidden: true,
            },
          },
          commands: {
            v2review: {
              template: "Review with current OpenCode command schema for $ARGUMENTS.",
              description: "Review from current OpenCode command schema",
            },
            v2docs: {
              template: "Draft docs with current OpenCode command schema for $ARGUMENTS.",
              description: "Draft docs through current OpenCode agent schema",
              agent: "v2architect",
            },
            disabledv2docs: {
              template: "Draft docs with a disabled v2 architect for $ARGUMENTS.",
              description: "Draft docs without disabled current OpenCode architect",
              agent: "disabledv2architect",
            },
          },
          agents: {
            v2architect: {
              description: "Architect from current OpenCode agents schema",
              mode: "subagent",
            },
            disabledv2architect: {
              description: "Disabled architect from current OpenCode agents schema",
              mode: "subagent",
              disabled: true,
            },
          },
        }),
      );
      await writeFile(
        path.join(cwd, "opencode.jsonc"),
        [
          "{",
          '  "$schema": "https://opencode.ai/config.json",',
          "  // OpenCode supports JSONC config files.",
          '  "command": {',
          '    "jsoncplan": {',
          '      "template": "Plan JSONC-backed work for $ARGUMENTS.",',
          '      "description": "Plan from project JSONC config",',
          '      "agent": "jsoncarchitect",',
          "    },",
          "  },",
          '  "agent": {',
          '    "jsoncarchitect": {',
          '      "description": "Architect from project JSONC config",',
          '      "mode": "subagent",',
          "    },",
          "  },",
          "}",
        ].join("\n"),
      );
      await mkdir(opencodeHome, { recursive: true });
      await writeAgentMarkdown({
        root: path.join(opencodeHome, "agent"),
        fileName: "global-legacy.md",
        description: "Global singular agent path",
        mode: "subagent",
      });
      await mkdir(path.join(opencodeHome, "commands"), { recursive: true });
      await writeFile(
        path.join(opencodeHome, "commands", "changelog.md"),
        "---\ndescription: Update the changelog\n---\n\nUpdate CHANGELOG.md for $ARGUMENTS.\n",
      );
      await mkdir(path.join(opencodeHome, "commands", "release"), { recursive: true });
      await writeFile(
        path.join(opencodeHome, "commands", "release", "notes.md"),
        "---\ndescription: Draft nested release notes\n---\n\nDraft release notes for $ARGUMENTS.\n",
      );
      await mkdir(path.join(opencodeHome, "command"), { recursive: true });
      await writeFile(
        path.join(opencodeHome, "command", "legacy-global.md"),
        "---\ndescription: Global singular command path\n---\n\nRun the global legacy command for $ARGUMENTS.\n",
      );
      await writeFile(
        path.join(opencodeHome, "opencode.json"),
        JSON.stringify({
          command: {
            component: {
              template: "Create a React component named $ARGUMENTS.",
              description: "Create a component",
              agent: "build",
            },
            scoutdeps: {
              template: "Research dependencies for $ARGUMENTS.",
              description: "Scout dependency docs",
              agent: " Scout ",
            },
            isolated: {
              template: "Run isolated analysis for $ARGUMENTS.",
              description: "Run as subtask",
              subtask: true,
            },
          },
          agent: {
            scout: {
              description: "Research dependencies",
              mode: "subagent",
            },
            architect: {
              description: "Design implementation options",
              mode: "all",
            },
            helper: {
              description: "Default all-mode helper",
            },
            internal: {
              description: "Internal-only helper",
              mode: "subagent",
              hidden: true,
            },
            build: {
              description: "Primary builder",
              mode: "primary",
            },
          },
        }),
      );

      expect(discoverGitHubCopilotAgentSlashCommands({ cwd })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "readme-creator",
            kind: "agent",
            promptPrefix: "@readme-creator",
          }),
          expect.objectContaining({
            name: "repo-auditor",
            kind: "agent",
            promptPrefix: "@repo-auditor",
          }),
          expect.objectContaining({
            name: "workspace-helper",
            kind: "agent",
            description: "Modern plural-suffix Copilot custom agent",
            promptPrefix: "@workspace-helper",
          }),
          expect.objectContaining({
            name: "claude-format",
            kind: "agent",
            description: "Claude-format Copilot agent",
            promptPrefix: "@claude-format",
          }),
          expect.objectContaining({
            name: "configured",
            kind: "agent",
            description: "Configured Copilot agent root",
            promptPrefix: "@configured",
          }),
          expect.objectContaining({
            name: "workflow",
            kind: "agent",
            description: "Workflow configured agent",
            promptPrefix: "@workflow",
          }),
          expect.objectContaining({
            name: "explore",
            kind: "agent",
            description: "Project explore override",
            promptPrefix: "@explore",
          }),
          expect.objectContaining({
            name: "planning",
            kind: "agent",
            description: "Plan work before implementation",
            promptPrefix: "@planning",
          }),
          expect.objectContaining({
            name: "vscode-only",
            kind: "agent",
            description: "VS Code only agent",
            promptPrefix: "@vscode-only",
          }),
          expect.objectContaining({
            name: "release-manager",
            kind: "agent",
            description: "Coordinates release readiness",
            promptPrefix: "@release-manager",
            inputHint: "<release plan>",
            metadata: {
              provider: "github-copilot",
              source: "agent",
              agents: ["security-auditor", "programmatic-researcher"],
              model: ["Claude Opus 4.5", "GPT-5.2"],
              tools: ["read_file", "grep"],
              skills: ["release-review", "migration-audit"],
              annotations: {
                team: "Release Engineering",
                workflow: "release-readiness",
              },
              handoffs: [
                {
                  label: "Implement Release Plan",
                  agent: "agent",
                  prompt: "Implement the release plan.",
                  send: false,
                  model: "GPT-5.2 (copilot)",
                },
              ],
              infer: false,
            },
          }),
          expect.objectContaining({
            name: "mcp-specialist",
            kind: "agent",
            description: "Uses an agent-scoped MCP server",
            metadata: expect.objectContaining({
              provider: "github-copilot",
              source: "agent",
              tools: ["read", "custom-mcp/tool-1"],
              mcpServers: {
                "custom-mcp": {
                  type: "local",
                  command: "some-command",
                  args: ["--arg1", "--arg2"],
                  tools: ["*"],
                  timeout: 30,
                  env: {
                    ENV_VAR_NAME: "${{ secrets.COPILOT_MCP_ENV_VAR_VALUE }}",
                  },
                },
              },
            }),
          }),
          expect.objectContaining({
            name: "mcp-list-specialist",
            kind: "agent",
            description: "Uses list-form MCP server config",
            metadata: expect.objectContaining({
              provider: "github-copilot",
              source: "agent",
              mcpServers: {
                "list-docs": {
                  type: "http",
                  url: "https://list.example.test/mcp",
                  tools: ["search", "read"],
                  headers: {
                    "X-List": "true",
                  },
                },
                "nested-local": {
                  type: "local",
                  command: "nested-mcp",
                  args: ["--stdio"],
                  tools: ["nested_search"],
                },
              },
            }),
          }),
        ]),
      );
      expect(findCommand(discoverGitHubCopilotAgentSlashCommands({ cwd }), "vscode-only")).toEqual(
        expect.objectContaining({
          kind: "agent",
          promptPrefix: "@vscode-only",
          metadata: {
            provider: "github-copilot",
            source: "agent",
            target: ["vscode"],
          },
        }),
      );
      expect(
        findCommand(discoverGitHubCopilotAgentSlashCommands({ cwd }), "zed-only"),
      ).toBeUndefined();
      expect(findCommand(discoverGitHubCopilotAgentSlashCommands({ cwd }), "planning")).toEqual(
        expect.objectContaining({
          kind: "agent",
          promptPrefix: "@planning",
        }),
      );
      expect(
        findCommand(discoverGitHubCopilotAgentSlashCommands({ cwd }), "ignored"),
      ).toBeUndefined();
      expect(
        findCommand(discoverGitHubCopilotAgentSlashCommands({ cwd }), "programmatic-researcher"),
      ).toBeUndefined();
      expect(
        findCommand(discoverGitHubCopilotAgentSlashCommands({ cwd }), "workspace-helper.agents"),
      ).toBeUndefined();
      expect(
        findCommand(discoverGitHubCopilotAgentSlashCommands({ cwd }), "missing-description"),
      ).toBeUndefined();
      expect(
        discoverGitHubCopilotAgentConfigOption({
          selectedAgent: "release-manager",
          commands: discoverGitHubCopilotAgentSlashCommands({ cwd }),
        }),
      ).toEqual({
        id: "agent",
        name: "Agent",
        category: "agent",
        type: "select",
        currentValue: "release-manager",
        description: "GitHub Copilot custom agent for this session.",
        options: expect.arrayContaining([
          {
            value: "default",
            name: "Default",
            description: "Use GitHub Copilot's default agent for this session.",
          },
          {
            value: "release-manager",
            name: "release-manager",
            description: "Coordinates release readiness",
          },
        ]),
      });
      expect(discoverGitHubCopilotAgentSlashCommands({ cwd, home: copilotHome })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "incident-reviewer",
            kind: "agent",
            promptPrefix: "@incident-reviewer",
          }),
          expect.objectContaining({
            name: "user-reviewer",
            kind: "agent",
            promptPrefix: "@user-reviewer",
          }),
        ]),
      );
      expect(discoverGitHubCopilotMcpServers({ cwd, home: copilotHome })).toEqual({
        personal: {
          command: "personal-mcp",
          args: ["--stdio"],
          env: {
            COPILOT_MCP_SCOPE: "personal",
          },
          tools: ["personal_read"],
        },
        fetch: {
          type: "local",
          command: "uvx",
          args: ["mcp-server-fetch"],
          tools: ["fetch"],
        },
        shared: {
          type: "http",
          url: "https://workspace.example.test/mcp",
          headers: {
            "X-Workspace": "true",
          },
          tools: ["workspace_search"],
        },
        repo: {
          type: "sse",
          url: "https://repo.example.test/sse",
          tools: ["repo_search"],
        },
      });
      expect(discoverGitHubCopilotCustomAgents({ cwd })).toEqual(
        expect.arrayContaining([
          {
            name: "readme-creator",
            displayName: "readme-creator",
            description: "Create README files",
            prompt: "# Agent prompt",
          },
          {
            name: "repo-auditor",
            description: "Audit repository health",
            prompt: "# Agent prompt",
          },
          {
            name: "workspace-helper",
            description: "Modern plural-suffix Copilot custom agent",
            prompt: "# Agent prompt",
          },
          {
            name: "configured",
            description: "Configured Copilot agent root",
            prompt: "# Agent prompt",
          },
          {
            name: "claude-format",
            description: "Claude-format Copilot agent",
            prompt: "# Agent prompt",
          },
          {
            name: "workflow",
            description: "Workflow configured agent",
            prompt: "# Agent prompt",
          },
          {
            name: "planning",
            description: "Plan work before implementation",
            prompt: "# Agent prompt",
          },
          {
            name: "release-manager",
            displayName: "Release Manager",
            description: "Coordinates release readiness",
            argumentHint: "<release plan>",
            prompt: "Plan and verify release readiness.",
            agents: ["security-auditor", "programmatic-researcher"],
            model: ["Claude Opus 4.5", "GPT-5.2"],
            metadata: {
              team: "Release Engineering",
              workflow: "release-readiness",
            },
            handoffs: [
              {
                label: "Implement Release Plan",
                agent: "agent",
                prompt: "Implement the release plan.",
                send: false,
                model: "GPT-5.2 (copilot)",
              },
            ],
            hooks: {
              PostToolUse: [
                {
                  type: "command",
                  command: "./scripts/format-changed-files.sh",
                  timeout: 15,
                },
              ],
            },
            skills: ["release-review", "migration-audit"],
            tools: ["read_file", "grep"],
            infer: false,
          },
          {
            name: "programmatic-researcher",
            description: "Researches implementation context programmatically",
            prompt: "Research implementation details without direct user invocation.",
            tools: [],
            infer: false,
            userInvocable: false,
            disableModelInvocation: true,
            target: ["github-copilot"],
            mcpServers: {
              "local-docs": {
                type: "local",
                command: "docs-mcp",
                args: ["--stdio"],
                tools: ["search"],
                env: { DOCS_MODE: "local" },
              },
            },
          },
          {
            name: "mcp-specialist",
            description: "Uses an agent-scoped MCP server",
            prompt: "Use the custom MCP server for specialist research.",
            tools: ["read", "custom-mcp/tool-1"],
            target: ["github-copilot"],
            mcpServers: {
              "custom-mcp": {
                type: "local",
                command: "some-command",
                args: ["--arg1", "--arg2"],
                tools: ["*"],
                timeout: 30,
                env: {
                  ENV_VAR_NAME: "${{ secrets.COPILOT_MCP_ENV_VAR_VALUE }}",
                },
              },
            },
          },
          {
            name: "mcp-list-specialist",
            description: "Uses list-form MCP server config",
            prompt: "Use list-form MCP server configuration for specialist research.",
            target: ["github-copilot"],
            mcpServers: {
              "list-docs": {
                type: "http",
                url: "https://list.example.test/mcp",
                tools: ["search", "read"],
                headers: {
                  "X-List": "true",
                },
              },
              "nested-local": {
                type: "local",
                command: "nested-mcp",
                args: ["--stdio"],
                tools: ["nested_search"],
              },
            },
          },
          {
            name: "automatic-specialist",
            description: "Allows automatic model invocation using the current Copilot field",
            prompt: "Use this agent automatically when its specialty applies.",
            infer: true,
            disableModelInvocation: false,
            target: ["github-copilot"],
          },
          {
            name: "target-list-specialist",
            description: "Uses block-list target and current field aliases",
            argumentHint: "<topic>",
            prompt: "Handle target-list Copilot agent tasks.",
            infer: false,
            userInvocable: true,
            disableModelInvocation: true,
            target: ["github-copilot"],
          },
          {
            name: "snake-target-specialist",
            description: "Uses snake-case agent field aliases",
            argumentHint: "<subject>",
            prompt: "Handle snake-case Copilot agent tasks.",
            infer: true,
            userInvocable: true,
            disableModelInvocation: false,
            target: ["github-copilot"],
          },
        ]),
      );
      expect(
        discoverGitHubCopilotCustomAgents({ cwd }).some((agent) => agent.name === "vscode-only"),
      ).toBe(true);
      expect(
        discoverGitHubCopilotCustomAgents({ cwd }).some((agent) => agent.name === "zed-only"),
      ).toBe(false);
      expect(
        discoverGitHubCopilotCustomAgents({ cwd }).some(
          (agent) => agent.name === "missing-description",
        ),
      ).toBe(false);
      expect(discoverGitHubCopilotCustomAgents({ cwd, home: copilotHome })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "incident-reviewer",
            displayName: "incident-reviewer",
            description: "Review production incidents",
            prompt: "# Agent prompt",
          }),
          expect.objectContaining({
            name: "user-reviewer",
            description: "Review user-level tasks",
            prompt: "# Agent prompt",
          }),
        ]),
      );
      expect(discoverGitHubCopilotPromptSlashCommands({ cwd, home: copilotHome })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "release-ready",
            kind: "provider",
            description: "Review release readiness",
            promptPrefix: "@plan Review release readiness for $ARGUMENTS.",
            inputHint: "<release>",
            metadata: {
              provider: "github-copilot",
              source: "prompt",
              agent: "plan",
              model: "GPT-5.2",
              tools: ["search/codebase"],
            },
          }),
          expect.objectContaining({
            name: "tooling",
            kind: "provider",
            description: "Run a tool-using prompt",
            promptPrefix: "@agent Use tools to answer $ARGUMENTS.",
            metadata: {
              provider: "github-copilot",
              source: "prompt",
              agent: "agent",
              tools: ["search/codebase", "vscode/askQuestion"],
            },
          }),
          expect.objectContaining({
            name: "summary",
            kind: "provider",
            description: "PR Summary",
            promptPrefix: "# PR Summary\n\nDraft a pull request summary for $ARGUMENTS.",
          }),
          expect.objectContaining({
            name: "configured",
            kind: "provider",
            description: "Configured Prompt",
            promptPrefix: "# Configured Prompt\n\nRun the configured prompt for $ARGUMENTS.",
          }),
          expect.objectContaining({
            name: "workflow",
            kind: "provider",
            description: "Workflow Prompt",
            promptPrefix: "# Workflow Prompt\n\nRun the workflow prompt for $ARGUMENTS.",
          }),
          expect.objectContaining({
            name: "incident",
            kind: "provider",
            description: "Incident prompt",
            promptPrefix: "# Incident prompt\n\nInvestigate the incident for $ARGUMENTS.",
          }),
        ]),
      );
      expect(
        findCommand(
          discoverGitHubCopilotPromptSlashCommands({ cwd, home: copilotHome }),
          "ignored",
        ),
      ).toBeUndefined();
      expect(discoverGitHubCopilotInstructionSlashCommands({ cwd, home: copilotHome })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "instructions:agents",
            kind: "provider",
            description: "Repository Agents",
            promptPrefix: "# Repository Agents\n\nUse repository-wide agent instructions.",
          }),
          expect.objectContaining({
            name: "instructions:claude",
            kind: "provider",
            description: "Claude Compatibility",
            promptPrefix: "# Claude Compatibility\n\nUse Claude rules.",
          }),
          expect.objectContaining({
            name: "instructions:gemini",
            kind: "provider",
            description: "Gemini Compatibility",
            promptPrefix: "# Gemini Compatibility\n\nUse Gemini rules.",
          }),
          expect.objectContaining({
            name: "instructions:copilot",
            kind: "provider",
            description: "Repository Copilot instructions",
            promptPrefix: "Follow the repository Copilot workflow.",
          }),
          expect.objectContaining({
            name: "instructions:frontend",
            kind: "provider",
            description: "Frontend Copilot instructions",
            promptPrefix: "Use frontend-specific Copilot conventions.",
            metadata: {
              provider: "github-copilot",
              source: "instructions",
              fileGlobs: "apps/web/**",
            },
          }),
          expect.objectContaining({
            name: "instructions:accessibility:ui",
            kind: "provider",
            description: "Accessibility instructions",
            promptPrefix: "Preserve accessible UI behavior.",
            metadata: {
              provider: "github-copilot",
              source: "instructions",
              fileGlobs: "**/*.tsx",
            },
          }),
          expect.objectContaining({
            name: "instructions:configured",
            kind: "provider",
            description: "Configured instruction root",
            promptPrefix: "Use the configured Copilot instruction root.",
          }),
          expect.objectContaining({
            name: "instructions:workspace-style",
            kind: "provider",
            description: "Claude-format workspace rules",
            promptPrefix: "Use Claude-format workspace rules for Copilot.",
          }),
          expect.objectContaining({
            name: "instructions:workflow:workflow-instructions-nested",
            kind: "provider",
            description: "Workflow Instructions",
            promptPrefix: "# Workflow Instructions\n\nUse workflow-specific instructions.",
          }),
        ]),
      );
      expect(
        findCommand(
          discoverGitHubCopilotInstructionSlashCommands({ cwd, home: copilotHome }),
          "instructions:ignored:disabled-instructions",
        ),
      ).toBeUndefined();
      expect(
        discoverGitHubCopilotPromptSlashCommands({ cwd: nestedCwd, home: copilotHome }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "release-ready",
            kind: "provider",
            promptPrefix: "@plan Review release readiness for $ARGUMENTS.",
          }),
        ]),
      );
      expect(
        discoverGitHubCopilotInstructionSlashCommands({ cwd: nestedCwd, home: copilotHome }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "instructions:agents:packages-app",
            kind: "provider",
            description: "Package Agents",
            promptPrefix: "# Package Agents\n\nUse package-local agent instructions.",
          }),
          expect.objectContaining({
            name: "instructions:agents",
            kind: "provider",
            promptPrefix: "# Repository Agents\n\nUse repository-wide agent instructions.",
          }),
          expect.objectContaining({
            name: "instructions:copilot",
            kind: "provider",
            description: "Repository Copilot instructions",
          }),
        ]),
      );
      expect(discoverGitHubCopilotInstructionSlashCommands({ home: copilotHome })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "instructions:copilot",
            kind: "provider",
            description: "Personal Copilot Instructions",
            promptPrefix:
              "# Personal Copilot Instructions\n\nUse the user's personal Copilot preferences.",
          }),
          expect.objectContaining({
            name: "instructions:personal",
            kind: "provider",
            description: "Personal File Instructions",
            promptPrefix: "# Personal File Instructions\n\nUse personal file-scoped instructions.",
          }),
        ]),
      );
      expect(discoverGitHubCopilotSkillDirectories({ cwd, home: copilotHome })).toEqual(
        expect.arrayContaining([
          path.join(cwd, ".github", "skills"),
          path.join(cwd, ".claude", "skills"),
          path.join(cwd, ".github", "copilot", "skills"),
          path.join(cwd, "workflow-skills"),
          path.join(copilotHome, "skills"),
        ]),
      );
      expect(discoverGitHubCopilotSkillDirectories({ cwd, home: copilotHome })).not.toContain(
        path.join(cwd, "disabled-skills"),
      );
      expect(discoverGitHubCopilotSkillDirectories({ cwd: nestedCwd, home: copilotHome })).toEqual(
        expect.arrayContaining([
          path.join(cwd, ".github", "skills"),
          path.join(cwd, ".claude", "skills"),
          path.join(cwd, ".github", "copilot", "skills"),
          path.join(cwd, "workflow-skills"),
          path.join(copilotHome, "skills"),
        ]),
      );
      const copilotProviderCommands = withProviderExtensionSlashCommands({
        providers: [
          {
            provider: "githubCopilot",
            enabled: true,
            installed: true,
            version: "1.0.0",
            minimumVersion: null,
            versionStatus: "ok",
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-01-01T00:00:00.000Z",
            models: [],
          },
        ],
        cwd,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            githubCopilot: {
              ...DEFAULT_SERVER_SETTINGS.providers.githubCopilot,
              homePath: copilotHome,
            },
          },
        },
      })[0]?.commands;
      expect(copilotProviderCommands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "incident-reviewer",
            kind: "agent",
            promptPrefix: "@incident-reviewer",
          }),
          expect.objectContaining({
            name: "configured",
            kind: "agent",
            promptPrefix: "@configured",
          }),
          expect.objectContaining({
            name: "claude-format",
            kind: "agent",
            promptPrefix: "@claude-format",
          }),
          expect.objectContaining({
            name: "workflow",
            kind: "agent",
            promptPrefix: "@workflow",
          }),
          expect.objectContaining({
            name: "user-reviewer",
            kind: "agent",
            promptPrefix: "@user-reviewer",
          }),
          expect.objectContaining({
            name: "release-ready",
            kind: "provider",
            promptPrefix: "@plan Review release readiness for $ARGUMENTS.",
          }),
          expect.objectContaining({
            name: "incident",
            kind: "provider",
            promptPrefix: "# Incident prompt\n\nInvestigate the incident for $ARGUMENTS.",
          }),
          expect.objectContaining({
            name: "instructions:agents",
            kind: "provider",
            promptPrefix: "# Repository Agents\n\nUse repository-wide agent instructions.",
          }),
          expect.objectContaining({
            name: "instructions:copilot",
            kind: "provider",
            description: "Repository Copilot instructions",
            promptPrefix: "Follow the repository Copilot workflow.",
          }),
          expect.objectContaining({
            name: "instructions:frontend",
            kind: "provider",
            description: "Frontend Copilot instructions",
            promptPrefix: "Use frontend-specific Copilot conventions.",
          }),
          expect.objectContaining({
            name: "explore",
            kind: "agent",
            description: "Project explore override",
            promptPrefix: "@explore",
          }),
          expect.objectContaining({
            name: "release-manager",
            kind: "agent",
            promptPrefix: "@release-manager",
            inputHint: "<release plan>",
          }),
          expect.objectContaining({
            name: "task",
            kind: "agent",
            promptPrefix: "@task",
          }),
          expect.objectContaining({
            name: "general-purpose",
            kind: "agent",
            promptPrefix: "@general-purpose",
          }),
          expect.objectContaining({
            name: "code-review",
            kind: "agent",
            promptPrefix: "@code-review",
          }),
          expect.objectContaining({
            name: "research",
            kind: "agent",
            promptPrefix: "@research",
          }),
          expect.objectContaining({
            name: "rubber-duck",
            kind: "agent",
            promptPrefix: "@rubber-duck",
          }),
          expect.objectContaining({
            name: "fleet",
            kind: "agent",
            promptPrefix: "/fleet",
            metadata: {
              provider: "github-copilot",
              source: "built-in-subagent",
            },
          }),
          expect.objectContaining({
            name: "repo-skill",
            kind: "skill",
            promptPrefix: "/repo-skill",
          }),
          expect.objectContaining({
            name: "claude-compatible",
            kind: "skill",
            promptPrefix: "/claude-compatible",
          }),
          expect.objectContaining({
            name: "incident-review",
            kind: "skill",
            promptPrefix: "/incident-review",
          }),
          expect.objectContaining({
            name: "configured-skill",
            kind: "skill",
            promptPrefix: "/configured-skill",
          }),
          expect.objectContaining({
            name: "workflow-skill",
            kind: "skill",
            promptPrefix: "/workflow-skill",
          }),
        ]),
      );
      expect(findCommand(copilotProviderCommands ?? [], "explore")?.description).toBe(
        "Project explore override",
      );
      expect(findCommand(copilotProviderCommands ?? [], "ignored")).toBeUndefined();
      expect(findCommand(copilotProviderCommands ?? [], "ignored-skill")).toBeUndefined();
      const opencodeCommands = discoverOpenCodeAgentSlashCommands({ cwd, home: opencodeHome });
      expect(opencodeCommands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "review",
            kind: "agent",
            promptPrefix: "@review",
            metadata: {
              provider: "opencode",
              source: "agent",
              mode: "subagent",
              model: "anthropic/claude-sonnet-4-20250514",
              color: "accent",
              tools: ["read", "grep", "bash"],
              temperature: 0.2,
              maxSteps: 12,
              permission: {
                read: "allow",
                bash: {
                  "git *": "ask",
                  "rm *": "deny",
                },
                skill: {
                  "docs-*": "allow",
                },
                task: {
                  "*": "deny",
                  reviewer: "allow",
                },
              },
              taskPermission: {
                "*": "deny",
                reviewer: "allow",
              },
            },
          }),
          expect.objectContaining({
            name: "research",
            kind: "agent",
            promptPrefix: "@research",
          }),
          expect.objectContaining({
            name: "default-helper",
            kind: "agent",
            promptPrefix: "@default-helper",
          }),
          expect.objectContaining({
            name: "legacy-scout",
            kind: "agent",
            promptPrefix: "@legacy-scout",
          }),
          expect.objectContaining({
            name: "global-legacy",
            kind: "agent",
            promptPrefix: "@global-legacy",
          }),
          expect.objectContaining({
            name: "scout",
            kind: "agent",
            promptPrefix: "@scout",
          }),
          expect.objectContaining({
            name: "architect",
            kind: "agent",
            promptPrefix: "@architect",
          }),
          expect.objectContaining({
            name: "helper",
            kind: "agent",
            promptPrefix: "@helper",
          }),
          expect.objectContaining({
            name: "test",
            kind: "provider",
            description: "Run project tests",
            promptPrefix: "/test",
            metadata: {
              provider: "opencode",
              source: "command",
              agent: "build",
            },
          }),
          expect.objectContaining({
            name: "analyze",
            kind: "agent",
            description: "Analyze without polluting primary context",
            promptPrefix: "/analyze",
            metadata: {
              provider: "opencode",
              source: "command",
              subtask: true,
            },
          }),
          expect.objectContaining({
            name: "review-fast",
            kind: "agent",
            description: "Review through the markdown subagent",
            promptPrefix: "/review-fast",
            metadata: {
              provider: "opencode",
              source: "command",
              agent: "review",
              model: "opencode/gpt-5.1-codex",
            },
          }),
          expect.objectContaining({
            name: "scout-fast",
            kind: "agent",
            description: "Scout through the built-in subagent",
            promptPrefix: "/scout-fast",
          }),
          expect.objectContaining({
            name: "review-inline",
            kind: "provider",
            description: "Review in the primary context",
            promptPrefix: "/review-inline",
            metadata: {
              provider: "opencode",
              source: "command",
              agent: "review",
              subtask: false,
            },
          }),
          expect.objectContaining({
            name: "disabled-fast",
            kind: "provider",
            description: "Try disabled markdown helper inline",
            promptPrefix: "/disabled-fast",
          }),
          expect.objectContaining({
            name: "internal-fast",
            kind: "agent",
            description: "Run hidden markdown subagent",
            promptPrefix: "/internal-fast",
            metadata: {
              provider: "opencode",
              source: "command",
              agent: "internal",
            },
          }),
          expect.objectContaining({
            name: "review-security",
            kind: "agent",
            description: "Review security in a nested OpenCode command",
            promptPrefix: "/review-security",
            metadata: {
              provider: "opencode",
              source: "command",
              agent: "review",
            },
          }),
          expect.objectContaining({
            name: "legacy-review",
            kind: "agent",
            description: "Legacy singular command path",
            promptPrefix: "/legacy-review",
          }),
          expect.objectContaining({
            name: "changelog",
            kind: "provider",
            description: "Update the changelog",
            promptPrefix: "/changelog",
          }),
          expect.objectContaining({
            name: "release-notes",
            kind: "provider",
            description: "Draft nested release notes",
            promptPrefix: "/release-notes",
          }),
          expect.objectContaining({
            name: "legacy-global",
            kind: "provider",
            description: "Global singular command path",
            promptPrefix: "/legacy-global",
          }),
          expect.objectContaining({
            name: "component",
            kind: "provider",
            description: "Create a component",
            promptPrefix: "/component",
          }),
          expect.objectContaining({
            name: "scoutdeps",
            kind: "agent",
            description: "Scout dependency docs",
            promptPrefix: "/scoutdeps",
          }),
          expect.objectContaining({
            name: "isolated",
            kind: "agent",
            description: "Run as subtask",
            promptPrefix: "/isolated",
          }),
          expect.objectContaining({
            name: "rootreview",
            kind: "provider",
            description: "Review from project root config",
            promptPrefix: "/rootreview",
          }),
          expect.objectContaining({
            name: "rootdocs",
            kind: "agent",
            description: "Draft docs through a subagent",
            promptPrefix: "/rootdocs",
            metadata: {
              provider: "opencode",
              source: "command",
              agent: "rootarchitect",
              model: "opencode/gpt-5.1-codex-mini",
            },
          }),
          expect.objectContaining({
            name: "v2review",
            kind: "provider",
            description: "Review from current OpenCode command schema",
            promptPrefix: "/v2review",
          }),
          expect.objectContaining({
            name: "v2docs",
            kind: "agent",
            description: "Draft docs through current OpenCode agent schema",
            promptPrefix: "/v2docs",
          }),
          expect.objectContaining({
            name: "disabledv2docs",
            kind: "provider",
            description: "Draft docs without disabled current OpenCode architect",
            promptPrefix: "/disabledv2docs",
          }),
          expect.objectContaining({
            name: "jsoncplan",
            kind: "agent",
            description: "Plan from project JSONC config",
            promptPrefix: "/jsoncplan",
          }),
          expect.objectContaining({
            name: "rootplan",
            kind: "provider",
            description: "Plan through primary build",
            promptPrefix: "/rootplan",
          }),
          expect.objectContaining({
            name: "disableddocs",
            kind: "provider",
            description: "Draft docs without disabled architect",
            promptPrefix: "/disableddocs",
          }),
          expect.objectContaining({
            name: "missingdescdocs",
            kind: "provider",
            description: "Draft docs without malformed architect",
            promptPrefix: "/missingdescdocs",
          }),
          expect.objectContaining({
            name: "internaldocs",
            kind: "agent",
            description: "Draft docs through hidden architect",
            promptPrefix: "/internaldocs",
            metadata: {
              provider: "opencode",
              source: "command",
              agent: "internalarchitect",
            },
          }),
          expect.objectContaining({
            name: "rootarchitect",
            kind: "agent",
            description: "Architect from project root config",
            promptPrefix: "@rootarchitect",
            metadata: {
              provider: "opencode",
              source: "agent",
              mode: "subagent",
              model: "opencode/gpt-5.1-codex",
              color: "#4ade80",
              permission: {
                read: "allow",
                bash: {
                  "git *": "ask",
                  "rm *": "deny",
                },
                skill: {
                  "docs-*": "allow",
                },
                task: {
                  "*": "deny",
                  reviewer: "allow",
                },
              },
              taskPermission: {
                "*": "deny",
                reviewer: "allow",
              },
            },
          }),
          expect.objectContaining({
            name: "v2architect",
            kind: "agent",
            description: "Architect from current OpenCode agents schema",
            promptPrefix: "@v2architect",
          }),
          expect.objectContaining({
            name: "jsoncarchitect",
            kind: "agent",
            description: "Architect from project JSONC config",
            promptPrefix: "@jsoncarchitect",
          }),
        ]),
      );
      expect(findCommand(opencodeCommands, "build")).toBeUndefined();
      expect(findCommand(opencodeCommands, "internal")).toBeUndefined();
      expect(findCommand(opencodeCommands, "internalarchitect")).toBeUndefined();
      expect(findCommand(opencodeCommands, "missing-description")).toBeUndefined();
      expect(findCommand(opencodeCommands, "disabled-helper")).toBeUndefined();
      expect(findCommand(opencodeCommands, "disabled-v2-helper")).toBeUndefined();
      expect(findCommand(opencodeCommands, "disabledarchitect")).toBeUndefined();
      expect(findCommand(opencodeCommands, "disabledv2architect")).toBeUndefined();
      expect(findCommand(opencodeCommands, "missingdescarchitect")).toBeUndefined();
      expect(discoverOpenCodeAgentSlashCommands({ cwd: nestedCwd, home: opencodeHome })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "rootreview",
            kind: "provider",
            promptPrefix: "/rootreview",
          }),
          expect.objectContaining({
            name: "rootdocs",
            kind: "agent",
            promptPrefix: "/rootdocs",
          }),
          expect.objectContaining({
            name: "legacy-scout",
            kind: "agent",
            promptPrefix: "@legacy-scout",
          }),
        ]),
      );
      const opencodeProviderCommands = withProviderExtensionSlashCommands({
        providers: [
          {
            provider: "opencode",
            enabled: true,
            installed: true,
            version: "1.0.0",
            minimumVersion: null,
            versionStatus: "ok",
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-01-01T00:00:00.000Z",
            models: [],
          },
        ],
        cwd,
        settings: DEFAULT_SERVER_SETTINGS,
      })[0]?.commands;
      expect(opencodeProviderCommands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "general",
            kind: "agent",
            promptPrefix: "@general",
          }),
          expect.objectContaining({
            name: "explore",
            kind: "agent",
            promptPrefix: "@explore",
          }),
          expect.objectContaining({
            name: "scout",
            kind: "agent",
            promptPrefix: "@scout",
          }),
          expect.objectContaining({
            name: "review",
            kind: "agent",
            promptPrefix: "@review",
          }),
        ]),
      );
      expect(opencodeProviderCommands?.filter((command) => command.name === "scout")).toHaveLength(
        1,
      );
      expect(findCommand(opencodeProviderCommands ?? [], "general")?.metadata).toEqual({
        provider: "opencode",
        source: "built-in-subagent",
      });
      const configuredOpenCodeProviderCommands = withProviderExtensionSlashCommands({
        providers: [
          {
            provider: "opencode",
            enabled: true,
            installed: true,
            version: "1.0.0",
            minimumVersion: null,
            versionStatus: "ok",
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-01-01T00:00:00.000Z",
            models: [],
          },
        ],
        cwd,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            opencode: {
              ...DEFAULT_SERVER_SETTINGS.providers.opencode,
              configDir: opencodeHome,
            },
          },
        },
      })[0]?.commands;
      expect(configuredOpenCodeProviderCommands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "changelog",
            kind: "provider",
            promptPrefix: "/changelog",
          }),
          expect.objectContaining({
            name: "component",
            kind: "provider",
            promptPrefix: "/component",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers GitHub Copilot installed plugin commands", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ace-copilot-plugin-commands-"));
    const copilotHome = path.join(root, ".copilot");
    const releasePlugin = path.join(copilotHome, "installed-plugins", "_direct", "release-tools");
    const repositoryPlugin = path.join(copilotHome, "installed-plugins", "company", "repo-plugin");
    const rootSkillPlugin = path.join(copilotHome, "plugins", "root-skill-plugin");
    const skillOnlyPlugin = path.join(copilotHome, "plugins", "skill-only-plugin");
    try {
      await mkdir(releasePlugin, { recursive: true });
      await writeFile(
        path.join(releasePlugin, "plugin.json"),
        JSON.stringify({
          name: "release-tools",
          description: "Release helper plugin",
        }),
      );
      await writeSkill(path.join(releasePlugin, "skills"), "deploy-review", "Review deploys");
      await writeAgentMarkdown({
        root: path.join(releasePlugin, "agents"),
        fileName: "release-manager.agent.md",
        name: "release-manager",
        description: "Coordinates release readiness",
      });
      await mkdir(path.join(releasePlugin, "commands"), { recursive: true });
      await writeFile(
        path.join(releasePlugin, "commands", "ship.md"),
        [
          "---",
          "description: Prepare a release ship plan",
          "---",
          "",
          "Prepare the release ship plan.",
        ].join("\n"),
      );

      await mkdir(path.join(repositoryPlugin, ".github", "plugin"), { recursive: true });
      await writeFile(
        path.join(repositoryPlugin, ".github", "plugin", "plugin.json"),
        JSON.stringify({
          name: "repo-plugin",
          description: "Repository layout plugin",
          skills: ["custom-skills", "more-skills"],
          commands: ["custom-commands"],
        }),
      );
      await writeSkill(path.join(repositoryPlugin, "custom-skills"), "triage", "Triage issues");
      await writeSkill(path.join(repositoryPlugin, "more-skills"), "debug", "Debug failures");
      await mkdir(path.join(repositoryPlugin, "custom-commands"), { recursive: true });
      await writeFile(
        path.join(repositoryPlugin, "custom-commands", "summarize.md"),
        [
          "---",
          "description: Summarize repository status",
          "---",
          "",
          "Summarize repository status.",
        ].join("\n"),
      );

      await mkdir(path.join(rootSkillPlugin, ".plugin"), { recursive: true });
      await writeFile(
        path.join(rootSkillPlugin, ".plugin", "plugin.json"),
        JSON.stringify({
          name: "root-skill-plugin",
          description: "Root skill plugin",
        }),
      );
      await writeFile(
        path.join(rootSkillPlugin, "SKILL.md"),
        [
          "---",
          "name: root-runbook",
          "description: Run the root plugin runbook",
          "---",
          "",
          "# Root runbook",
        ].join("\n"),
      );
      await mkdir(skillOnlyPlugin, { recursive: true });
      await writeFile(
        path.join(skillOnlyPlugin, "SKILL.md"),
        [
          "---",
          "name: skill-only-review",
          "description: Review through a SKILL-only Copilot plugin",
          "---",
          "",
          "# Skill-only review",
        ].join("\n"),
      );

      const commands = discoverGitHubCopilotPluginSlashCommands({ home: copilotHome });

      expect(commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "release-tools",
            kind: "plugin",
            promptPrefix: "Use the release-tools plugin.",
          }),
          expect.objectContaining({
            name: "release-tools:deploy-review",
            kind: "skill",
            promptPrefix: "/release-tools:deploy-review",
          }),
          expect.objectContaining({
            name: "release-tools:release-manager",
            kind: "agent",
            promptPrefix: "@release-manager",
          }),
          expect.objectContaining({
            name: "release-tools:ship",
            kind: "plugin",
            promptPrefix: "/release-tools:ship",
          }),
          expect.objectContaining({
            name: "repo-plugin",
            kind: "plugin",
          }),
          expect.objectContaining({
            name: "repo-plugin:triage",
            kind: "skill",
            promptPrefix: "/repo-plugin:triage",
          }),
          expect.objectContaining({
            name: "repo-plugin:debug",
            kind: "skill",
            promptPrefix: "/repo-plugin:debug",
          }),
          expect.objectContaining({
            name: "repo-plugin:summarize",
            kind: "plugin",
            promptPrefix: "/repo-plugin:summarize",
          }),
          expect.objectContaining({
            name: "root-runbook",
            kind: "skill",
            promptPrefix: "/root-runbook",
          }),
          expect.objectContaining({
            name: "skill-only-review",
            kind: "skill",
            promptPrefix: "/skill-only-review",
          }),
        ]),
      );

      const providerCommands = withProviderExtensionSlashCommands({
        providers: [
          {
            provider: "githubCopilot",
            enabled: true,
            installed: true,
            version: "1.0.0",
            minimumVersion: null,
            versionStatus: "ok",
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-01-01T00:00:00.000Z",
            models: [],
          },
        ],
        cwd: root,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            githubCopilot: {
              ...DEFAULT_SERVER_SETTINGS.providers.githubCopilot,
              homePath: copilotHome,
            },
          },
        },
      })[0]?.commands;

      expect(providerCommands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "release-tools",
          }),
          expect.objectContaining({
            name: "release-tools:deploy-review",
          }),
          expect.objectContaining({
            name: "release-tools:release-manager",
          }),
          expect.objectContaining({
            name: "repo-plugin:triage",
          }),
          expect.objectContaining({
            name: "skill-only-review",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("respects Copilot parent-repository customization and skill settings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ace-copilot-customization-settings-"));
    const repo = path.join(root, "repo");
    const nestedCwd = path.join(repo, "packages", "app");
    try {
      await mkdir(path.join(repo, ".git"), { recursive: true });
      await mkdir(path.join(nestedCwd, ".github", "agents"), { recursive: true });
      await writeAgentMarkdown({
        root: path.join(repo, ".github", "agents"),
        fileName: "parent-reviewer.agent.md",
        description: "Parent repository reviewer",
      });
      await writeAgentMarkdown({
        root: path.join(nestedCwd, ".github", "agents"),
        fileName: "nested-reviewer.agent.md",
        description: "Nested workspace reviewer",
      });
      await mkdir(path.join(repo, ".github", "prompts"), { recursive: true });
      await writeFile(
        path.join(repo, ".github", "prompts", "parent-plan.prompt.md"),
        "# Parent Plan\n\nPlan parent repository work.",
      );
      await writeSkill(path.join(repo, ".github", "skills"), "parent-skill", "Parent skill");

      expect(discoverGitHubCopilotAgentSlashCommands({ cwd: nestedCwd })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "nested-reviewer",
            kind: "agent",
          }),
        ]),
      );
      expect(
        findCommand(discoverGitHubCopilotAgentSlashCommands({ cwd: nestedCwd }), "parent-reviewer"),
      ).toBeUndefined();
      expect(
        findCommand(discoverGitHubCopilotPromptSlashCommands({ cwd: nestedCwd }), "parent-plan"),
      ).toBeUndefined();

      await mkdir(path.join(repo, ".vscode"), { recursive: true });
      await writeFile(
        path.join(repo, ".vscode", "settings.json"),
        JSON.stringify({
          "chat.useCustomizationsInParentRepositories": true,
        }),
      );
      expect(discoverGitHubCopilotAgentSlashCommands({ cwd: nestedCwd })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "parent-reviewer",
            kind: "agent",
          }),
        ]),
      );
      expect(discoverGitHubCopilotPromptSlashCommands({ cwd: nestedCwd })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "parent-plan",
            kind: "provider",
          }),
        ]),
      );

      await mkdir(path.join(nestedCwd, ".vscode"), { recursive: true });
      await writeFile(
        path.join(nestedCwd, ".vscode", "settings.json"),
        JSON.stringify({
          "chat.useCustomizationsInParentRepositories": true,
        }),
      );
      expect(discoverGitHubCopilotAgentSlashCommands({ cwd: nestedCwd })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "parent-reviewer",
            kind: "agent",
          }),
        ]),
      );
      expect(discoverGitHubCopilotPromptSlashCommands({ cwd: nestedCwd })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "parent-plan",
            kind: "provider",
          }),
        ]),
      );
      expect(discoverGitHubCopilotSkillDirectories({ cwd: nestedCwd })).toEqual(
        expect.arrayContaining([path.join(repo, ".github", "skills")]),
      );

      await writeFile(
        path.join(nestedCwd, ".vscode", "settings.json"),
        JSON.stringify({
          "chat.useCustomizationsInParentRepositories": true,
          "chat.useAgentSkills": false,
        }),
      );
      expect(discoverGitHubCopilotSkillDirectories({ cwd: nestedCwd })).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers Copilot organization custom agents from .github-private repository agents root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ace-copilot-private-agents-"));
    const repo = path.join(root, ".github-private");
    try {
      await mkdir(path.join(repo, ".git"), { recursive: true });
      await writeAgentMarkdown({
        root: path.join(repo, "agents"),
        fileName: "incident-commander.agent.md",
        description: "Coordinate incident response across repositories",
      });

      expect(discoverGitHubCopilotAgentSlashCommands({ cwd: repo })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "incident-commander",
            kind: "agent",
            promptPrefix: "@incident-commander",
          }),
        ]),
      );
      expect(discoverGitHubCopilotCustomAgents({ cwd: repo })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "incident-commander",
            description: "Coordinate incident response across repositories",
            prompt: "# Agent prompt",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies Copilot custom agent precedence for duplicate names", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ace-copilot-agent-precedence-"));
    const repo = path.join(root, "repo");
    const orgRepo = path.join(root, ".github-private");
    const copilotHome = path.join(root, "copilot-home");
    try {
      await mkdir(path.join(repo, ".git"), { recursive: true });
      await writeAgentMarkdown({
        root: path.join(repo, ".github", "agents"),
        fileName: "shared.agent.md",
        description: "Repository shared agent",
      });
      await writeAgentMarkdown({
        root: path.join(copilotHome, "agents"),
        fileName: "shared.agent.md",
        description: "User shared agent",
      });
      expect(discoverGitHubCopilotCustomAgents({ cwd: repo, home: copilotHome })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "shared",
            description: "Repository shared agent",
          }),
        ]),
      );

      await mkdir(path.join(orgRepo, ".git"), { recursive: true });
      await writeAgentMarkdown({
        root: path.join(orgRepo, "agents"),
        fileName: "shared.agent.md",
        description: "Organization shared agent",
      });
      expect(discoverGitHubCopilotCustomAgents({ cwd: orgRepo, home: copilotHome })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "shared",
            description: "Organization shared agent",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses Copilot custom-agent camel-case MCP server frontmatter", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ace-copilot-agent-mcp-camel-case-"));
    const repo = path.join(root, "repo");
    try {
      await mkdir(path.join(repo, ".git"), { recursive: true });
      await mkdir(path.join(repo, ".github", "agents"), { recursive: true });
      await writeFile(
        path.join(repo, ".github", "agents", "schema-explorer.agent.md"),
        [
          "---",
          "description: Explores schema docs",
          'mcpServers: {"schema-docs":{"type":"http","url":"https://docs.example.test/mcp","tools":["search"]}}',
          "---",
          "",
          "Explore schema documentation.",
        ].join("\n"),
      );

      expect(discoverGitHubCopilotCustomAgents({ cwd: repo })).toEqual([
        {
          name: "schema-explorer",
          description: "Explores schema docs",
          mcpServers: {
            "schema-docs": {
              type: "http",
              url: "https://docs.example.test/mcp",
              tools: ["search"],
            },
          },
          prompt: "Explore schema documentation.",
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("caps Copilot custom-agent prompts at GitHub's documented maximum", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ace-copilot-agent-prompt-cap-"));
    const repo = path.join(root, "repo");
    try {
      await mkdir(path.join(repo, ".git"), { recursive: true });
      await mkdir(path.join(repo, ".github", "agents"), { recursive: true });
      await writeFile(
        path.join(repo, ".github", "agents", "longform.agent.md"),
        ["---", "description: Long custom agent prompt", "---", "", "a".repeat(30_005)].join("\n"),
      );

      const [agent] = discoverGitHubCopilotCustomAgents({ cwd: repo });
      expect(agent?.name).toBe("longform");
      expect(agent?.prompt).toHaveLength(30_000);
      expect(agent?.prompt.endsWith("a")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("respects skill slash-command visibility frontmatter", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ace-skill-visibility-"));
    const repo = path.join(root, "repo");
    try {
      await mkdir(path.join(repo, ".git"), { recursive: true });
      await writeSkill(path.join(repo, ".github", "skills"), "visible", "Visible skill", [
        "argument-hint: [topic]",
        "arguments: [topic]",
        "tools: [search, read_file]",
        "model: GPT-5.2",
        "metadata:",
        "  team: Docs",
      ]);
      await writeSkill(path.join(repo, ".github", "skills"), "manual-only", "Manual-only skill", [
        "disable-model-invocation: true",
      ]);
      await mkdir(path.join(repo, ".github", "skills", "lowercase-manifest"), { recursive: true });
      await writeFile(
        path.join(repo, ".github", "skills", "lowercase-manifest", "skill.md"),
        [
          "---",
          "name: lowercase-manifest",
          "description: Lowercase Copilot skill manifest",
          "disableModelInvocation: true",
          "userInvocable: true",
          "---",
          "",
          "# Lowercase manifest",
        ].join("\n"),
      );
      await writeSkill(
        path.join(repo, ".github", "skills"),
        "background-only",
        "Background skill",
        ["user-invocable: false"],
      );
      await writeSkill(
        path.join(repo, ".github", "skills"),
        "legacy-background-only",
        "Legacy spelling background skill",
        ["user-invokable: false"],
      );
      await writeSkill(
        path.join(repo, ".github", "skills"),
        "camel-background-only",
        "Camel spelling background skill",
        ["userInvocable: false"],
      );
      await writeSkill(path.join(repo, ".github", "skills"), "disabled", "Disabled skill", [
        "user-invocable: false",
        "disable-model-invocation: true",
      ]);

      const commands = withProviderExtensionSlashCommands({
        providers: [
          {
            provider: "githubCopilot",
            enabled: true,
            installed: true,
            version: "1.0.0",
            minimumVersion: null,
            versionStatus: "ok",
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-01-01T00:00:00.000Z",
            models: [],
          },
        ],
        cwd: repo,
        settings: DEFAULT_SERVER_SETTINGS,
      })[0]?.commands;

      expect(commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "visible",
            kind: "skill",
            promptPrefix: "/visible",
            inputHint: "[topic]",
            metadata: {
              provider: "github-copilot",
              source: "skill",
              arguments: ["topic"],
              tools: ["search", "read_file"],
              model: "GPT-5.2",
              annotations: {
                team: "Docs",
              },
            },
          }),
          expect.objectContaining({
            name: "manual-only",
            kind: "skill",
            promptPrefix: "/manual-only",
            metadata: {
              provider: "github-copilot",
              source: "skill",
              disableModelInvocation: true,
            },
          }),
          expect.objectContaining({
            name: "lowercase-manifest",
            kind: "skill",
            promptPrefix: "/lowercase-manifest",
            metadata: {
              provider: "github-copilot",
              source: "skill",
              disableModelInvocation: true,
              userInvocable: true,
            },
          }),
        ]),
      );
      expect(findCommand(commands ?? [], "background-only")).toBeUndefined();
      expect(findCommand(commands ?? [], "legacy-background-only")).toBeUndefined();
      expect(findCommand(commands ?? [], "camel-background-only")).toBeUndefined();
      expect(findCommand(commands ?? [], "disabled")).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("respects Copilot custom-agent hook opt-in", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ace-copilot-agent-hooks-"));
    const repo = path.join(root, "repo");
    try {
      await mkdir(path.join(repo, ".git"), { recursive: true });
      await mkdir(path.join(repo, ".github", "agents"), { recursive: true });
      await writeFile(
        path.join(repo, ".github", "agents", "formatter.agent.md"),
        [
          "---",
          "description: Formats generated changes",
          "hooks:",
          "  postToolUse:",
          "    - type: command",
          "      command: ./scripts/format.sh",
          "  permission-request:",
          "    - type: command",
          "      command: ./scripts/check-permission.sh",
          "      timeout: 20",
          "  PostToolBatch:",
          "    - type: command",
          "      command: ./scripts/batch-summary.sh",
          "  task-completed:",
          "    - type: agent",
          "      prompt: Verify the completed subtask.",
          "  session-end:",
          "    - type: command",
          "      command: ./scripts/session-end.sh",
          "  instructions-loaded:",
          "    - type: command",
          "      command: ./scripts/instructions-loaded.sh",
          "---",
          "",
          "Format generated changes.",
        ].join("\n"),
      );
      await writeFile(
        path.join(repo, ".github", "agents", "background-only.agent.md"),
        [
          "---",
          "description: Hidden with alternate spelling",
          "user-invokable: false",
          "---",
          "",
          "Run only as an inferred subagent.",
        ].join("\n"),
      );

      expect(discoverGitHubCopilotCustomAgents({ cwd: repo })).toEqual([
        {
          name: "background-only",
          description: "Hidden with alternate spelling",
          userInvocable: false,
          prompt: "Run only as an inferred subagent.",
        },
        {
          name: "formatter",
          description: "Formats generated changes",
          prompt: "Format generated changes.",
        },
      ]);
      expect(discoverGitHubCopilotAgentSlashCommands({ cwd: repo })).toEqual([
        {
          name: "formatter",
          kind: "agent",
          promptPrefix: "@formatter",
          description: "Formats generated changes",
          inputHint: "<prompt>",
        },
      ]);

      await mkdir(path.join(repo, ".vscode"), { recursive: true });
      await writeFile(
        path.join(repo, ".vscode", "settings.json"),
        JSON.stringify({
          "chat.useCustomAgentHooks": true,
        }),
      );
      expect(discoverGitHubCopilotCustomAgents({ cwd: repo })).toEqual([
        {
          name: "background-only",
          description: "Hidden with alternate spelling",
          userInvocable: false,
          prompt: "Run only as an inferred subagent.",
        },
        {
          name: "formatter",
          description: "Formats generated changes",
          hooks: {
            PostToolUse: [
              {
                type: "command",
                command: "./scripts/format.sh",
              },
            ],
            PermissionRequest: [
              {
                type: "command",
                command: "./scripts/check-permission.sh",
                timeout: 20,
              },
            ],
            PostToolBatch: [
              {
                type: "command",
                command: "./scripts/batch-summary.sh",
              },
            ],
            TaskCompleted: [
              {
                type: "agent",
                prompt: "Verify the completed subtask.",
              },
            ],
            SessionEnd: [
              {
                type: "command",
                command: "./scripts/session-end.sh",
              },
            ],
            InstructionsLoaded: [
              {
                type: "command",
                command: "./scripts/instructions-loaded.sh",
              },
            ],
          },
          prompt: "Format generated changes.",
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
