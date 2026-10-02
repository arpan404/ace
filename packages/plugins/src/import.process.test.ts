import { describe, expect, test } from "vitest";
import { importPlugin, agentPluginSchema, agentMcpSchema, limits } from "./index.ts";
import { sampleFiles, sampleManifest } from "./test-support.ts";

describe("manifest and imports", () => {
  test("a portable capability set retains skill assets and execution configuration", () => {
    const imported = importPlugin(sampleFiles);
    expect(imported.manifest.skills).toEqual([{ name: "review", path: "skills/review" }]);
    expect(imported.manifest.mcpServers.tools).toMatchObject({
      command: "node",
      args: ["${PLUGIN_ROOT}/scripts/server.js", 'a quote: "'],
    });
    expect(imported.manifest.rules).toEqual([{ name: "style", path: "rules/style.md" }]);
  });
  test.each([
    "../escape",
    "./../escape",
    "/tmp/escape",
    "foo/../../escape",
    "foo\\bar",
    "C:/foo",
    "foo//bar",
    "foo/.git/config",
    "foo\u0000bar",
    "foo/constructor",
    "trailing.",
  ])("hostile component path %s is rejected before use", (path) => {
    expect(() =>
      importPlugin({
        "ace-plugin.json": JSON.stringify({
          ...sampleManifest,
          commands: [{ name: "check", path }],
        }),
      }),
    ).toThrow();
  });
  test("oversized manifests and files are rejected without component activation", () => {
    expect(() => importPlugin({ "ace-plugin.json": " ".repeat(limits.json + 1) })).toThrow(
      "JSON exceeds",
    );
    expect(() =>
      importPlugin({ ...sampleFiles, "asset.txt": "x".repeat(limits.file + 1) }),
    ).toThrow("byte limit");
    expect(() =>
      importPlugin({
        "ace-plugin.json": JSON.stringify({
          ...sampleManifest,
          hooks: [{ event: "Stop", command: "x".repeat(8193) }],
        }),
      }),
    ).toThrow();
  });
  test("duplicate skill names cannot overwrite a previously selected skill", () => {
    expect(() =>
      importPlugin({
        "ace-plugin.json": JSON.stringify({
          ...sampleManifest,
          skills: [
            { name: "same", path: "a" },
            { name: "same", path: "b" },
          ],
        }),
      }),
    ).toThrow("Duplicate");
  });
  test("Claude's default layout imports commands, skills, agents, MCP and command hooks", () => {
    const files = { ...sampleFiles };
    delete files["ace-plugin.json"];
    files[".claude-plugin/plugin.json"] = JSON.stringify({
      name: "sample",
      version: "1.0",
      lspServers: { ignored: {} },
    });
    files[".mcp.json"] = JSON.stringify({
      mcpServers: { local: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/scripts/server.js"] } },
    });
    files["hooks/hooks.json"] = JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "echo stop" },
              { type: "prompt", prompt: "Do not activate" },
            ],
          },
        ],
      },
    });
    const imported = importPlugin(files);
    expect(imported.manifest.commands).toEqual([{ name: "check", path: "commands/check.md" }]);
    expect(imported.manifest.agents).toEqual([{ name: "reviewer", path: "agents/reviewer.md" }]);
    expect(imported.manifest.mcpServers.local).toMatchObject({ type: "stdio", command: "node" });
    expect(imported.manifest.hooks).toEqual([
      { event: "Stop", command: "echo stop", matcher: "Bash" },
    ]);
    expect(imported.unsupported).toContain("Unsupported native field: lspServers");
    expect(imported.unsupported).toContain("Unsupported Stop hook type: prompt");
  });
  test("Claude custom paths and inline commands override defaults while extra skills are additive", () => {
    const imported = importPlugin({
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "sample",
        skills: "./extra/",
        commands: { about: { content: "Explain the plugin" } },
        agents: ["./custom/helper.md"],
        hooks: "./custom/hooks.json",
        mcpServers: "./custom/mcp.json",
      }),
      "skills/default/SKILL.md": "Default",
      "extra/extra/SKILL.md": "Extra",
      "commands/ignored.md": "Not loaded",
      "custom/helper.md": "Help",
      "custom/hooks.json": JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo start" }] }] },
      }),
      "custom/mcp.json": JSON.stringify({
        mcpServers: { docs: { type: "http", url: "https://example.com/mcp" } },
      }),
    });
    expect(imported.manifest.skills.map((skill) => skill.name)).toEqual(["default", "extra"]);
    expect(imported.manifest.commands.map((command) => command.name)).toEqual(["about"]);
    expect(Object.values(imported.inlineFiles)).toEqual(["Explain the plugin"]);
    expect(imported.manifest.agents).toEqual([{ name: "helper", path: "custom/helper.md" }]);
    expect(imported.manifest.hooks[0]?.command).toBe("echo start");
    expect(imported.manifest.mcpServers.docs).toMatchObject({ type: "http" });
  });
  test("Agent Plugins fixed locations load while vendor extensions remain inert", () => {
    const imported = importPlugin({
      "plugin.json": JSON.stringify({
        $schema: agentPluginSchema,
        name: "sample",
        extensions: { "com.example": { hooks: "never" } },
        commands: "./evil",
      }),
      "skills/review/SKILL.md": "Review",
      "commands/evil.md": "Never activate",
      "mcp.json": JSON.stringify({
        $schema: agentMcpSchema,
        mcpServers: {
          local: { type: "stdio", command: "./server", env: { MODE: "safe" } },
          docs: { type: "streamable-http", url: "https://example.com" },
          legacy: { type: "sse", url: "https://example.com/sse" },
        },
      }),
    });
    expect(imported.manifest.skills).toEqual([{ name: "review", path: "skills/review" }]);
    expect(imported.manifest.commands).toEqual([]);
    expect(imported.manifest.hooks).toEqual([]);
    expect(imported.manifest.mcpServers.docs).toMatchObject({ type: "http" });
    expect(imported.manifest.mcpServers.local).toMatchObject({ command: "./server" });
    expect(imported.unsupported).toContain("Unsupported extension: com.example");
    expect(imported.metadata).toMatchObject({ extensions: { "com.example": { hooks: "never" } } });
  });
  test("unsupported Agent Plugins schema versions and malformed metadata are rejected", () => {
    expect(() =>
      importPlugin({
        "plugin.json": JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json",
          name: "sample",
        }),
      }),
    ).toThrow();
    expect(() =>
      importPlugin({
        "plugin.json": JSON.stringify({
          $schema: agentPluginSchema,
          name: "sample",
          author: { name: 3 },
        }),
      }),
    ).toThrow();
    expect(() =>
      importPlugin({
        "plugin.json": JSON.stringify({ $schema: agentPluginSchema, name: "sample" }),
        "mcp.json": JSON.stringify({ mcpServers: {} }),
      }),
    ).toThrow();
  });
  test("Cursor native hooks keep their event names and Codex compatibility paths import", () => {
    const imported = importPlugin({
      ".cursor-plugin/plugin.json": JSON.stringify({ name: "sample" }),
      "hooks/hooks.json": JSON.stringify({
        hooks: { beforeShellExecution: [{ command: "echo review", matcher: "rm" }] },
      }),
    });
    expect(imported.manifest.hooks).toEqual([
      { event: "beforeShellExecution", command: "echo review", matcher: "rm" },
    ]);
    const codex = importPlugin({
      ".codex-plugin/plugin.json": JSON.stringify({ name: "sample", skills: "./skills" }),
      "skills/tool/SKILL.md": "Tool",
    });
    expect(codex.manifest.skills).toEqual([{ name: "tool", path: "skills/tool" }]);
  });
});
