import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ProviderSlashCommand } from "@ace/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@ace/contracts/settings";
import { describe, expect, it } from "vitest";

import {
  discoverClaudeExtensionSlashCommands,
  discoverCodexExtensionSlashCommands,
  discoverGenericProviderExtensionSlashCommands,
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
        ]),
      );
      expect(findCommand(providerCommands ?? [], "design-audit")?.description).toBe(
        "Local audit UI",
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
          skills: "skills",
          commands: "commands",
        }),
      );
      await writeSkill(path.join(pluginRoot, "skills"), "deploy-review", "Review deployments");
      await writeSkill(
        path.join(cwd, ".claude", "skills"),
        "claude-project",
        "Claude project skill",
      );
      await writeSkill(
        path.join(cwd, ".claude", "skills"),
        "shared-global",
        "Claude project override",
      );
      await writeSkill(path.join(claudeHome, "skills"), "claude-global", "Claude global skill");
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
            name: "claude-project",
            kind: "skill",
            promptPrefix: "Use the claude-project skill:",
          }),
          expect.objectContaining({
            name: "claude-global",
            kind: "skill",
            promptPrefix: "Use the claude-global skill:",
          }),
          expect.objectContaining({
            name: "shared-global",
            kind: "skill",
            promptPrefix: "Use the shared-global skill:",
          }),
          expect.objectContaining({
            name: "acme-plugin",
            kind: "plugin",
            promptPrefix: "Use the acme-plugin plugin.",
          }),
          expect.objectContaining({
            name: "acme-plugin:deploy-review",
            kind: "skill",
            promptPrefix: "Use the deploy-review skill from the acme-plugin plugin:",
          }),
          expect.objectContaining({
            name: "acme-plugin:deploy",
            kind: "plugin",
            promptPrefix: "/acme-plugin:deploy",
          }),
        ]),
      );
      expect(findCommand(commands, "shared-global")?.description).toBe("Claude project override");
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
      await writeSkill(path.join(agentsHome, "skills"), "shared-global", "Shared global skill");

      const commands = discoverGenericProviderExtensionSlashCommands({
        cwd,
        home: geminiHome,
        agentsHome,
        providerHomeDirName: ".gemini",
      });
      expect(commands).toEqual(
        expect.arrayContaining([
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
