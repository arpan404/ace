import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ProviderSlashCommand } from "@ace/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@ace/contracts/settings";
import { describe, expect, it } from "vitest";

import {
  discoverClaudeExtensionSlashCommands,
  discoverCodexExtensionSlashCommands,
  discoverCursorExtensionSlashCommands,
  discoverGeminiCustomSlashCommands,
  discoverGenericProviderExtensionSlashCommands,
  discoverGeminiExtensionSlashCommands,
  discoverGitHubCopilotAgentSlashCommands,
  discoverGitHubCopilotCustomAgents,
  discoverGitHubCopilotSkillDirectories,
  discoverOpenCodeAgentSlashCommands,
  discoverPiExtensionSlashCommands,
  withProviderExtensionSlashCommands,
} from "./providerExtensionSlashCommands.ts";

async function writeSkill(root: string, name: string, description: string): Promise<void> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

async function writeMarkdownSkill(
  root: string,
  fileName: string,
  name: string,
  description?: string | undefined,
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, fileName),
    [
      "---",
      `name: ${name}`,
      ...(description ? [`description: ${description}`] : []),
      "---",
      "",
      "# Markdown skill",
    ].join("\n"),
  );
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
}): Promise<void> {
  await mkdir(input.root, { recursive: true });
  await writeFile(
    path.join(input.root, input.fileName),
    [
      "---",
      ...(input.name ? [`name: ${input.name}`] : []),
      `description: ${input.description}`,
      ...(input.mode ? [`mode: ${input.mode}`] : []),
      "---",
      "",
      "# Agent prompt",
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
  it("discovers concrete Codex skill and plugin commands", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ace-extension-commands-"));
    const cwd = path.join(root, "repo");
    const codexHome = path.join(root, ".codex");
    const agentsHome = path.join(root, ".agents");
    try {
      await writeSkill(path.join(cwd, ".codex", "skills"), "codex-local", "Codex local skill");
      await writeSkill(path.join(cwd, ".codex", "skills"), "design-audit", "Local audit UI");
      await writeSkill(path.join(cwd, ".agents", "skills"), "designx", "Design UI");
      await writeSkill(path.join(agentsHome, "skills"), "frontend-design", "Build UI");
      await writeSkill(path.join(codexHome, "skills"), "design-audit", "Audit UI");
      await writeSkill(path.join(codexHome, "skills", ".system"), "imagegen", "Generate images");

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
            name: "design-audit",
            kind: "skill",
            promptPrefix: "$design-audit",
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
      await writeSkill(path.join(pluginRoot, "skills"), "deploy-review", "Review deployments");
      await writeSkill(
        path.join(cwd, ".claude", "skills"),
        "claude-project",
        "Claude project skill",
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
        path.join(cwd, ".claude", "commands", "frontend", "component.md"),
        "# Component\n\nCreate a component using $ARGUMENTS.\n",
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
            promptPrefix: "/security-auditor",
          }),
          expect.objectContaining({
            name: "docs-writer",
            kind: "agent",
            promptPrefix: "/docs-writer",
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
            name: "frontend:component",
            kind: "provider",
            description: "Component",
            promptPrefix: "/frontend:component",
            inputHint: "<prompt>",
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
            promptPrefix: "/incident-agent",
          }),
          expect.objectContaining({
            name: "acme-plugin:deploy-review",
            kind: "skill",
            promptPrefix: "/acme-plugin:deploy-review",
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
      expect(findCommand(commands, "folder-command")?.promptPrefix).toBe("/folder-command");
      expect(findCommand(commands, "Display Name Only")).toBeUndefined();
      expect(
        findCommand(
          discoverClaudeExtensionSlashCommands({ cwd: nestedCwd, home: claudeHome, agentsHome }),
          "claude-project",
        )?.promptPrefix,
      ).toBe("/claude-project");

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
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers generic provider skill roots", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ace-generic-extension-commands-"));
    const cwd = path.join(root, "repo");
    const geminiHome = path.join(root, ".gemini");
    const agentsHome = path.join(root, ".agents");
    try {
      await writeSkill(path.join(cwd, ".gemini", "skills"), "gemini-project", "Gemini project");
      await writeSkill(path.join(cwd, ".agents", "skills"), "designx", "Project shared skill");
      await writeSkill(
        path.join(cwd, ".agents", "skills"),
        "frontend-design",
        "Project frontend design",
      );
      await writeSkill(path.join(geminiHome, "skills"), "frontend-design", "Build UI");
      await writeAgentMarkdown({
        root: path.join(cwd, ".gemini", "agents"),
        fileName: "security-auditor.md",
        name: "security-auditor",
        description: "Find security defects",
      });
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
      await writeAgentMarkdown({
        root: path.join(extensionRoot, "agents"),
        fileName: "cloud-architect.md",
        name: "cloud-architect",
        description: "Design Google Cloud architecture",
      });
      await mkdir(path.join(extensionRoot, "commands", "gcs"), { recursive: true });
      await writeFile(
        path.join(extensionRoot, "commands", "gcs", "sync.toml"),
        'description = "Sync Cloud Storage buckets"\n',
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
      await mkdir(path.join(geminiHome, "commands"), { recursive: true });
      await writeFile(
        path.join(geminiHome, "commands", "review.toml"),
        'description = "Global review command"\nprompt = "Review globally."\n',
      );
      await writeFile(
        path.join(geminiHome, "commands", "triage.toml"),
        'description = "Triage an issue"\nprompt = "Triage {{args}}."\n',
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
      const customCommands = discoverGeminiCustomSlashCommands({ cwd, home: geminiHome });
      expect(customCommands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "review",
            kind: "provider",
            promptPrefix: "/review",
            description: "Review the current diff",
          }),
          expect.objectContaining({
            name: "git:commit",
            kind: "provider",
            promptPrefix: "/git:commit",
            description: "Draft a commit message",
          }),
          expect.objectContaining({
            name: "triage",
            kind: "provider",
            promptPrefix: "/triage",
            description: "Triage an issue",
          }),
        ]),
      );
      expect(findCommand(customCommands, "review")?.description).toBe("Review the current diff");
      const extensionCommands = discoverGeminiExtensionSlashCommands({ home: geminiHome });
      expect(extensionCommands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "cloud-architect",
            kind: "agent",
            promptPrefix: "@cloud-architect",
          }),
          expect.objectContaining({
            name: "cloud-run-deploy",
            kind: "skill",
            promptPrefix: "Use the cloud-run-deploy skill:",
          }),
          expect.objectContaining({
            name: "gcs:sync",
            kind: "plugin",
            promptPrefix: "/gcs:sync",
            description: "Sync Cloud Storage buckets",
          }),
        ]),
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
            promptPrefix: "/review",
          }),
          expect.objectContaining({
            name: "triage",
            kind: "provider",
            promptPrefix: "/triage",
          }),
          expect.objectContaining({
            name: "gcs:sync",
            kind: "plugin",
            promptPrefix: "/gcs:sync",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers Pi skills from current documented locations", async () => {
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
      );
      await writeMarkdownSkill(path.join(repo, ".pi", "skills"), "ignored.md", "ignored");
      await writeSkill(path.join(cwd, ".agents", "skills"), "designx", "Nested shared skill");
      await writeSkill(path.join(piAgentDir, "skills"), "deploy", "Global Pi deploy skill");
      await writeMarkdownSkill(
        path.join(piAgentDir, "skills"),
        "transcribe.md",
        "transcribe",
        "Global Markdown transcribe skill",
      );
      await writeSkill(path.join(agentsHome, "skills"), "frontend-design", "Shared global skill");

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
        ]),
      );
      expect(findCommand(commands, "skill:deploy")?.description).toBe("Project Pi deploy skill");
      expect(findCommand(commands, "skill:ignored")).toBeUndefined();
      expect(findCommand(commands, "deploy")).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers Cursor project and global Markdown commands", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ace-cursor-extension-commands-"));
    const cwd = path.join(root, "repo");
    const cursorHome = path.join(root, ".cursor-home");
    try {
      await writeCursorCommand(
        path.join(cwd, ".cursor", "commands"),
        "security-audit.md",
        "# Security Audit\n\nReview the code for security risks.",
      );
      await writeCursorCommand(
        path.join(cwd, ".cursor", "commands"),
        "create-pr.md",
        "---\ndescription: Draft a pull request\n---\n\nWrite a pull request summary.",
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
        root: path.join(cwd, ".cursor", "agents"),
        fileName: "security-auditor.md",
        name: "security-auditor",
        description: "Security specialist. Use when auth or payments change.",
      });
      await writeAgentMarkdown({
        root: path.join(cwd, ".claude", "agents"),
        fileName: "security-auditor.md",
        name: "security-auditor",
        description: "Claude compatibility duplicate should lose to Cursor.",
      });
      await writeAgentMarkdown({
        root: path.join(cwd, ".codex", "agents"),
        fileName: "verifier.md",
        name: "verifier",
        description: "Codex compatibility verifier.",
      });
      await writeAgentMarkdown({
        root: path.join(cursorHome, "agents"),
        fileName: "release-reviewer.md",
        name: "release-reviewer",
        description: "Global release reviewer.",
      });
      await writeSkill(
        path.join(cwd, ".cursor", "skills", "workflow"),
        "land-it",
        "Land a finished change.",
      );
      await writeSkill(
        path.join(cwd, ".agents", "skills"),
        "shared-context",
        "Apply shared project context.",
      );
      await writeSkill(
        path.join(cwd, ".claude", "skills"),
        "claude-compat",
        "Claude compatibility skill.",
      );
      await writeSkill(path.join(cursorHome, "skills"), "global-skill", "Global Cursor skill.");

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
          }),
          expect.objectContaining({
            name: "create-pr",
            kind: "plugin",
            promptPrefix: "Write a pull request summary.",
            description: "Draft a pull request",
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
          }),
          expect.objectContaining({
            name: "verifier",
            kind: "agent",
            promptPrefix: "/verifier",
            description: "Codex compatibility verifier.",
          }),
          expect.objectContaining({
            name: "release-reviewer",
            kind: "agent",
            promptPrefix: "/release-reviewer",
            description: "Global release reviewer.",
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
        ]),
      );
      expect(findCommand(commands, "security-audit")?.promptPrefix).toBe(
        "# Security Audit\n\nReview the code for security risks.",
      );
      expect(findCommand(commands, "security-auditor")?.description).toBe(
        "Security specialist. Use when auth or payments change.",
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
      await writeFile(
        path.join(cwd, ".github", "agents", "release-manager.agent.md"),
        [
          "---",
          "name: Release Manager",
          "description: Coordinates release readiness",
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
      await writeSkill(path.join(cwd, ".github", "skills"), "repo-skill", "Use repo skill");
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
        path.join(cwd, "opencode.json"),
        JSON.stringify({
          command: {
            rootreview: {
              template: "Review repository state for $ARGUMENTS.",
              description: "Review from project root config",
            },
          },
          agent: {
            rootarchitect: {
              description: "Architect from project root config",
              mode: "subagent",
            },
          },
        }),
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
      await writeFile(
        path.join(opencodeHome, "opencode.json"),
        JSON.stringify({
          command: {
            component: {
              template: "Create a React component named $ARGUMENTS.",
              description: "Create a component",
              agent: "build",
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
        ]),
      );
      expect(
        findCommand(discoverGitHubCopilotAgentSlashCommands({ cwd }), "vscode-only"),
      ).toBeUndefined();
      expect(
        findCommand(discoverGitHubCopilotAgentSlashCommands({ cwd }), "programmatic-researcher"),
      ).toBeUndefined();
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
            name: "release-manager",
            displayName: "Release Manager",
            description: "Coordinates release readiness",
            prompt: "Plan and verify release readiness.",
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
            mcpServers: {
              "local-docs": {
                type: "stdio",
                command: "docs-mcp",
                args: ["--stdio"],
                tools: ["search"],
                env: { DOCS_MODE: "local" },
              },
            },
          },
        ]),
      );
      expect(
        discoverGitHubCopilotCustomAgents({ cwd }).some((agent) => agent.name === "vscode-only"),
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
      expect(discoverGitHubCopilotSkillDirectories({ cwd, home: copilotHome })).toEqual(
        expect.arrayContaining([
          path.join(cwd, ".github", "skills"),
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
            name: "user-reviewer",
            kind: "agent",
            promptPrefix: "@user-reviewer",
          }),
          expect.objectContaining({
            name: "repo-skill",
            kind: "skill",
            promptPrefix: "Use the repo-skill skill:",
          }),
          expect.objectContaining({
            name: "incident-review",
            kind: "skill",
            promptPrefix: "Use the incident-review skill:",
          }),
        ]),
      );
      const opencodeCommands = discoverOpenCodeAgentSlashCommands({ cwd, home: opencodeHome });
      expect(opencodeCommands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "review",
            kind: "agent",
            promptPrefix: "@review",
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
          }),
          expect.objectContaining({
            name: "changelog",
            kind: "provider",
            description: "Update the changelog",
            promptPrefix: "/changelog",
          }),
          expect.objectContaining({
            name: "component",
            kind: "provider",
            description: "Create a component",
            promptPrefix: "/component",
          }),
          expect.objectContaining({
            name: "rootreview",
            kind: "provider",
            description: "Review from project root config",
            promptPrefix: "/rootreview",
          }),
          expect.objectContaining({
            name: "rootarchitect",
            kind: "agent",
            description: "Architect from project root config",
            promptPrefix: "@rootarchitect",
          }),
        ]),
      );
      expect(findCommand(opencodeCommands, "build")).toBeUndefined();
      expect(findCommand(opencodeCommands, "internal")).toBeUndefined();
      expect(discoverOpenCodeAgentSlashCommands({ cwd: nestedCwd, home: opencodeHome })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "rootreview",
            kind: "provider",
            promptPrefix: "/rootreview",
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
});
