import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, expect, test } from "vitest";
import { materializeProjection, projectPlugins } from "./index.ts";
import type { Provider } from "./index.ts";
import { fixture, writeFiles, git, sampleFiles, sampleManifest } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup() {
  const f = await fixture();
  cleanups.push(f.close);
  await f.manager.accept(await f.prepare());
  return f;
}
async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

test("Claude receives native commands, agents, hook matchers, skill resources and MCP config", async () => {
  const f = await setup();
  const root = join(f.root, "claude");
  const projection = projectPlugins("claude", await f.manager.installed(), { root });
  await materializeProjection(projection, { root });
  const base = join(root, "generated/plugins/sample");
  expect(projection.args).toEqual([
    "--plugin-dir",
    base,
    "--mcp-config",
    join(root, "generated/mcp.json"),
    "--append-system-prompt-file",
    join(root, "generated/instructions.md"),
  ]);
  expect(await readFile(join(base, "skills/review/references/checklist.md"), "utf8")).toBe(
    "Check failure behavior.",
  );
  expect(await readFile(join(base, "commands/check.md"), "utf8")).toContain(
    "Run checks $ARGUMENTS",
  );
  expect(await readFile(join(base, "agents/reviewer.md"), "utf8")).toContain(
    "Review behavior and failure paths.",
  );
  expect(await json(join(base, "hooks/hooks.json"))).toEqual({
    hooks: {
      SessionStart: [
        {
          matcher: "startup",
          hooks: [
            { type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/payload/scripts/start.js" },
          ],
        },
      ],
    },
  });
  expect(await json(join(root, "generated/mcp.json"))).toMatchObject({
    mcpServers: {
      "ace-sample__tools": {
        command: "node",
        args: [`${base}/payload/scripts/server.js`, 'a quote: "'],
        env: { MODE: "local" },
      },
      "ace-sample__docs": { type: "http", url: "https://example.com/mcp" },
    },
  });
  expect(await readFile(join(root, "generated/instructions.md"), "utf8")).toBe("Use TypeScript.");
  expect((await lstat(join(base, "payload/scripts/start.js"))).mode & 0o111).not.toBe(0);
  expect(projection.unsupported).toEqual([]);
});
test("Codex loads skills through an ace marketplace and passes TOML MCP overrides with native bundled hooks", async () => {
  const f = await setup();
  const root = join(f.root, "codex");
  const projection = projectPlugins("codex", await f.manager.installed(), { root });
  await materializeProjection(projection, { root });
  expect(projection.args).toContain('plugins."sample@ace".enabled=true');
  expect(projection.args).toContain('marketplaces.ace.source_type="local"');
  expect(projection.args).toContain(
    `marketplaces.ace.source=${JSON.stringify(join(root, "generated"))}`,
  );
  expect(await json(join(root, "generated/.agents/plugins/marketplace.json"))).toMatchObject({
    name: "ace",
    plugins: [{ name: "sample", source: { source: "local", path: "./plugins/sample" } }],
  });
  expect(
    await readFile(join(root, "generated/plugins/sample/skills/review/SKILL.md"), "utf8"),
  ).toContain("Check the behavior.");
  expect(projection.args).toContain(
    `mcp_servers."ace-sample__tools"={"command"="node","args"=[${JSON.stringify(join(root, "generated/plugins/sample/payload/scripts/server.js"))},"a quote: \\""],"env"={"MODE"="local"}}`,
  );
  expect(projection.args).toContain('developer_instructions="Use TypeScript."');
  expect(await json(join(root, "generated/plugins/sample/hooks/hooks.json"))).toEqual({
    hooks: {
      SessionStart: [
        {
          matcher: "startup",
          hooks: [{ type: "command", command: "node ${PLUGIN_ROOT}/payload/scripts/start.js" }],
        },
      ],
    },
  });
  expect(projection.unsupported).toEqual([
    "sample: codex cannot inject slash command check",
    "sample: codex cannot inject agent reviewer",
  ]);
  expect(projection.env).toEqual({});
});
test("OpenCode runtime content adds skills, command templates, subagent prompts, instructions and MCP", async () => {
  const f = await setup();
  const root = join(f.root, "opencode");
  const projection = projectPlugins("opencode", await f.manager.installed(), { root });
  await materializeProjection(projection, { root });
  const config = z
    .object({ instructions: z.array(z.string()), skills: z.object({ paths: z.array(z.string()) }) })
    .passthrough()
    .parse(JSON.parse(projection.env.OPENCODE_CONFIG_CONTENT ?? "null"));
  expect(config.skills.paths).toEqual([join(root, "generated/plugins/sample/skills")]);
  expect(await readFile(join(config.skills.paths[0] ?? "", "review/SKILL.md"), "utf8")).toContain(
    "Check the behavior.",
  );
  expect(config).toMatchObject({
    command: { "ace-sample__check": { template: "Run checks $ARGUMENTS" } },
    agent: {
      "ace-sample__reviewer": { mode: "subagent", prompt: "Review behavior and failure paths." },
    },
    mcp: {
      "ace-sample__tools": {
        type: "local",
        command: [
          "node",
          join(root, "generated/plugins/sample/payload/scripts/server.js"),
          'a quote: "',
        ],
        environment: { MODE: "local" },
        enabled: true,
      },
      "ace-sample__docs": { type: "remote", url: "https://example.com/mcp" },
    },
  });
  expect(await readFile(config.instructions[0] ?? "", "utf8")).toBe("Use TypeScript.");
  expect(projection.unsupported).toEqual(["sample: opencode cannot inject hook SessionStart"]);
});
test("Cursor receives native plugin skills, slash commands, agents, unconditional rules and hooks", async () => {
  const f = await setup();
  const root = join(f.root, "cursor");
  const projection = projectPlugins("cursor", await f.manager.installed(), { root });
  await materializeProjection(projection, { root });
  const base = join(root, "generated/plugins/sample");
  expect(projection.args).toEqual(["--plugin-dir", base]);
  expect(await json(join(base, ".cursor-plugin/plugin.json"))).toMatchObject({ name: "sample" });
  expect(await readFile(join(base, "rules/style.mdc"), "utf8")).toContain(
    "alwaysApply: true\n---\nUse TypeScript.",
  );
  expect(await json(join(base, "hooks/hooks.json"))).toEqual({
    hooks: {
      sessionStart: [
        { command: "node ${CURSOR_PLUGIN_ROOT}/payload/scripts/start.js", matcher: "startup" },
      ],
    },
  });
  expect(await json(join(base, "mcp.json"))).toMatchObject({
    mcpServers: { "ace-sample__tools": { command: "node" } },
  });
  expect(await readFile(join(base, "commands/check.md"), "utf8")).toContain("Run checks");
  expect(await readFile(join(base, "agents/reviewer.md"), "utf8")).toContain("Review behavior");
  expect(projection.unsupported).toEqual([]);
});
test.each<Provider>(["acp", "antigravity"])(
  "%s receives session MCP with explicit diagnostics for unsupported file capabilities",
  async (provider) => {
    const f = await setup();
    const snapshots = await f.manager.installed();
    const root = join(f.root, provider);
    const projection = projectPlugins(provider, snapshots, { root });
    expect(projection.files).toEqual([]);
    expect(projection.sessionConfig.mcpServers).toContainEqual({
      name: "ace-sample__tools",
      command: "node",
      args: [join(snapshots[0]?.root ?? "", "scripts/server.js"), 'a quote: "'],
      env: [{ name: "MODE", value: "local" }],
    });
    expect(projection.sessionConfig.mcpServers).toContainEqual({
      name: "ace-sample__docs",
      type: "http",
      url: "https://example.com/mcp",
      headers: [{ name: "X-Mode", value: "test" }],
    });
    expect(projection.unsupported).toHaveLength(5);
  },
);
test("unknown hook events and unsupported transport or cwd are reported instead of misconfigured", async () => {
  const f = await setup();
  const snapshots = await f.manager.installed();
  const plugin = snapshots[0];
  if (!plugin) throw new Error("Missing fixture");
  plugin.manifest.hooks.push({ event: "UnknownEvent", command: "echo ignored" });
  plugin.manifest.mcpServers.legacy = { type: "sse", url: "https://example.com/sse", headers: {} };
  plugin.manifest.mcpServers.cwd = {
    type: "stdio",
    command: "node",
    args: [],
    env: {},
    cwd: "./scripts",
  };
  const root = join(f.root, "projection");
  expect(projectPlugins("codex", snapshots, { root }).unsupported).toContain(
    "ace-sample__legacy: Codex does not support SSE MCP",
  );
  expect(projectPlugins("opencode", snapshots, { root }).unsupported).toContain(
    "ace-sample__cwd: OpenCode cannot inject MCP cwd",
  );
  const acp = projectPlugins("acp", snapshots, { root });
  expect(acp.unsupported).toContain("ace-sample__cwd: ACP cannot inject MCP cwd");
  expect(acp.sessionConfig.mcpServers?.some((server) => server.name === "ace-sample__cwd")).toBe(
    false,
  );
  const claude = projectPlugins("claude", snapshots, { root });
  expect(claude.unsupported).toContain("sample: unsupported hook UnknownEvent");
  expect(
    claude.files.find((file) => file.path.endsWith("hooks/hooks.json"))?.content,
  ).not.toContain("ignored");
});
test("two plugins whose names overlap retain distinct MCP servers and OpenCode commands", async () => {
  const f = await setup();
  await writeFiles(f.repo, {
    "marketplace.json": JSON.stringify({
      name: "test",
      plugins: [
        { name: "a-b", source: "./plugins/first" },
        { name: "a", source: "./plugins/second" },
      ],
    }),
  });
  await writeFiles(join(f.repo, "plugins/first"), {
    "ace-plugin.json": JSON.stringify({
      schemaVersion: 1,
      name: "a-b",
      version: "1",
      mcpServers: { c: { type: "stdio", command: "first" } },
      commands: [{ name: "c", path: "command.md" }],
    }),
    "command.md": "First command",
  });
  await writeFiles(join(f.repo, "plugins/second"), {
    "ace-plugin.json": JSON.stringify({
      schemaVersion: 1,
      name: "a",
      version: "1",
      mcpServers: { "b-c": { type: "stdio", command: "second" } },
      commands: [{ name: "b-c", path: "command.md" }],
    }),
    "command.md": "Second command",
  });
  await git(f.repo, ["add", "."]);
  await git(f.repo, ["commit", "-m", "overlapping names"]);
  for (const name of ["a-b", "a"])
    await f.manager.accept(await f.manager.prepare({ repository: f.repo, ref: "main", name }));
  const projection = projectPlugins("opencode", await f.manager.installed(), {
    root: join(f.root, "namespace"),
  });
  expect(JSON.parse(projection.env.OPENCODE_CONFIG_CONTENT ?? "null")).toMatchObject({
    mcp: { "ace-a-b__c": { command: ["first"] }, "ace-a__b-c": { command: ["second"] } },
    command: {
      "ace-a-b__c": { template: "First command" },
      "ace-a__b-c": { template: "Second command" },
    },
  });
});
test("custom skill directories keep nested resources beside each native skill definition", async () => {
  const f = await fixture({
    ...sampleFiles,
    "ace-plugin.json": JSON.stringify({
      ...sampleManifest,
      skills: [
        { name: "review", path: "skills/review" },
        { name: "second", path: "custom/nested" },
      ],
    }),
    "custom/nested/SKILL.md": "Second skill",
    "custom/nested/references/deep/info.md": "Second reference",
  });
  cleanups.push(f.close);
  await f.manager.accept(await f.prepare());
  const root = join(f.root, "skill-roots");
  await materializeProjection(projectPlugins("claude", await f.manager.installed(), { root }), {
    root,
  });
  expect(
    await readFile(
      join(root, "generated/plugins/sample/skills/review/references/checklist.md"),
      "utf8",
    ),
  ).toBe("Check failure behavior.");
  expect(
    await readFile(join(root, "generated/plugins/sample/skills/second/SKILL.md"), "utf8"),
  ).toBe("Second skill");
  expect(
    await readFile(
      join(root, "generated/plugins/sample/skills/second/references/deep/info.md"),
      "utf8",
    ),
  ).toBe("Second reference");
});
