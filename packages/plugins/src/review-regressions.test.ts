import { execFile } from "node:child_process";
import { chmod, lstat, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { afterEach, expect, test } from "vitest";
import {
  agentPluginSchema,
  agentMcpSchema,
  importPlugin,
  inspectPackage,
  materializeProjection,
  projectPlugins,
} from "./index.ts";
import { fixture, git, sampleFiles, writeFiles } from "./test-support.ts";

const execute = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup(files: Record<string, string> = sampleFiles) {
  const f = await fixture(files);
  cleanups.push(f.close);
  await f.manager.accept(await f.prepare());
  return f;
}

test.each(["hooks", "mcpServers"])(
  "cyclic %s file references fail with a bounded import error",
  (component) => {
    expect(() =>
      importPlugin({
        ".claude-plugin/plugin.json": JSON.stringify({ name: "sample", [component]: "cycle.json" }),
        "cycle.json": JSON.stringify("cycle.json"),
      }),
    ).toThrow("Cyclic component reference");
  },
);
test("repeated hook aliases are rejected before their expanded handlers exceed the budget", () => {
  const files: Record<string, string> = {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "sample", hooks: "alias-0.json" }),
    "leaf.json": JSON.stringify({ Stop: [{ command: "echo safe" }] }),
  };
  for (let index = 0; index < 16; index++) {
    const next = index === 15 ? "leaf.json" : `alias-${index + 1}.json`;
    files[`alias-${index}.json`] = JSON.stringify([next, next]);
  }
  expect(() => importPlugin(files)).toThrow("Import expansion limit");
});
test("Cursor custom paths replace default skills, MCP and hook discovery", () => {
  const imported = importPlugin({
    ".cursor-plugin/plugin.json": JSON.stringify({
      name: "sample",
      skills: "selected",
      mcpServers: "selected.json",
      hooks: "selected-hooks.json",
    }),
    "skills/unselected/SKILL.md": "Unselected",
    "selected/chosen/SKILL.md": "Selected",
    "mcp.json": JSON.stringify({
      mcpServers: { unselected: { command: "unselected-executable" } },
    }),
    "selected.json": JSON.stringify({ mcpServers: { chosen: { command: "selected-executable" } } }),
    "hooks/hooks.json": JSON.stringify({ Stop: [{ command: "unselected-hook" }] }),
    "selected-hooks.json": JSON.stringify({ Stop: [{ command: "selected-hook" }] }),
  });
  expect(imported.manifest.skills).toEqual([{ name: "chosen", path: "selected/chosen" }]);
  expect(Object.keys(imported.manifest.mcpServers)).toEqual(["chosen"]);
  expect(imported.manifest.hooks.map((hook) => hook.command)).toEqual(["selected-hook"]);
});
test.each(["acp", "antigravity"] as const)(
  "%s session resources survive plugin update and removal",
  async (provider) => {
    const f = await setup({ ...sampleFiles, "scripts/server.js": "console.log('PLUGIN');" });
    const snapshots = await f.manager.installed();
    const oldRoot = snapshots[0]?.root ?? "missing";
    const root = join(f.root, "session");
    const projection = projectPlugins(provider, snapshots, { root });
    await materializeProjection(projection, { root });
    await writeFile(join(f.repo, "plugins/sample/scripts/server.js"), "console.log('UPDATED');");
    await git(f.repo, ["add", "."]);
    await git(f.repo, ["commit", "-m", "update"]);
    await f.manager.accept(await f.manager.update("sample"));
    await f.manager.remove("sample");
    await expect(lstat(oldRoot)).rejects.toMatchObject({ code: "ENOENT" });
    const server = z
      .object({ command: z.string(), args: z.array(z.string()) })
      .parse(
        projection.sessionConfig.mcpServers?.find((entry) => entry.name === "ace-sample__tools"),
      );
    expect((await execute(server.command, server.args)).stdout.trim()).toBe("PLUGIN");
  },
);
test.each([undefined, "${PLUGIN_ROOT}", "${PLUGIN_ROOT}/scripts", "./scripts"])(
  "portable stdio cwd %s executes the bundled script rather than the workspace script",
  async (cwd) => {
    const file = cwd?.endsWith("scripts") ? "scripts/server.js" : "server.js";
    const f = await setup({
      "plugin.json": JSON.stringify({ $schema: agentPluginSchema, name: "sample", version: "1" }),
      "mcp.json": JSON.stringify({
        $schema: agentMcpSchema,
        mcpServers: {
          tools: {
            type: "stdio",
            command: process.execPath,
            args: ["server.js"],
            ...(cwd === undefined ? {} : { cwd }),
          },
        },
      }),
      [file]: "console.log('PLUGIN');",
    });
    const workspace = join(f.root, "workspace");
    await writeFiles(workspace, { "server.js": "console.log('WORKSPACE');" });
    const root = join(f.root, "session");
    const snapshots = await f.manager.installed();
    const projection = projectPlugins("claude", snapshots, { root });
    await materializeProjection(projection, { root });
    const config = z
      .object({
        mcpServers: z.record(
          z.string(),
          z.object({ command: z.string(), args: z.array(z.string()), cwd: z.string().optional() }),
        ),
      })
      .parse(JSON.parse(await readFile(join(root, "generated/mcp.json"), "utf8")));
    const server = config.mcpServers["ace-sample__tools"];
    if (!server) throw new Error("Missing server");
    expect(
      (await execute(server.command, server.args, { cwd: server.cwd ?? workspace })).stdout.trim(),
    ).toBe("PLUGIN");
    for (const provider of ["opencode", "acp", "antigravity"] as const)
      expect(projectPlugins(provider, snapshots, { root }).unsupported.join("\n")).toContain(
        "cannot inject MCP cwd",
      );
  },
);
test("conditional Cursor rules retain selectors and cannot silently become global provider instructions", async () => {
  const rule =
    '---\ndescription: Java guidelines\nglobs: "**/*.java"\nalwaysApply: false\n---\nUse Java conventions.';
  const f = await setup({ ...sampleFiles, "rules/style.md": rule });
  const root = join(f.root, "session");
  const snapshots = await f.manager.installed();
  const cursor = projectPlugins("cursor", snapshots, { root });
  expect(
    cursor.files.find((file) => file.path === "generated/plugins/sample/rules/style.mdc")?.content,
  ).toBe(rule);
  for (const provider of ["claude", "codex", "opencode"] as const) {
    const projection = projectPlugins(provider, snapshots, { root });
    expect(projection.unsupported).toContain(
      `sample: ${provider} cannot preserve conditional rule style`,
    );
    expect(
      [
        ...projection.args,
        ...Object.values(projection.env),
        ...projection.files
          .filter((file) => !file.path.includes("/payload/"))
          .map((file) => file.content ?? ""),
      ].join("\n"),
    ).not.toContain("Use Java conventions.");
  }
});

test("crash recovery preserves old output when the next replacement fails", async () => {
  const f = await setup();
  const root = join(f.root, "session");
  const snapshots = await f.manager.installed();
  const projection = projectPlugins("claude", snapshots, { root });
  await materializeProjection(projection, { root });
  await writeFile(join(root, "generated/instructions.md"), "Previous usable instructions");
  await rename(join(root, "generated"), join(root, ".ace-previous"));
  await writeFile(join(snapshots[0]?.root ?? "missing", "scripts/server.js"), "tampered");
  await expect(materializeProjection(projection, { root })).rejects.toThrow("Integrity mismatch");
  expect(await readFile(join(root, "generated/instructions.md"), "utf8")).toBe(
    "Previous usable instructions",
  );
});
test("provider invocation rejects oversized individual and aggregate overrides", async () => {
  const f = await setup();
  const snapshots = await f.manager.installed();
  const plugin = snapshots[0];
  if (!plugin) throw new Error("Missing plugin");
  plugin.text["rules/style.md"] = "x".repeat(64 * 1024 + 1);
  expect(() => projectPlugins("codex", snapshots, { root: join(f.root, "session") })).toThrow(
    "Provider override exceeds byte limit",
  );
  plugin.text["rules/style.md"] = "short";
  plugin.manifest.mcpServers = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [
      `large-${index}`,
      { type: "stdio", command: "node", args: ["x".repeat(8192)], env: {} },
    ]),
  );
  expect(() => projectPlugins("codex", snapshots, { root: join(f.root, "session") })).toThrow(
    "Provider override exceeds byte limit",
  );
});
test.each(["commands", "agents", "rules"] as const)(
  "missing %s cannot be reviewed or installed",
  async (component) => {
    const f = await fixture({
      "ace-plugin.json": JSON.stringify({
        schemaVersion: 1,
        name: "sample",
        version: "1",
        [component]: [{ name: "missing", path: "missing.md" }],
      }),
    });
    cleanups.push(f.close);
    await expect(f.prepare()).rejects.toThrow("Component missing");
    expect(f.manager.pending()).toEqual([]);
    expect(await readdir(join(f.managerRoot, "staging"))).toEqual([]);
  },
);
test("a rename alone changes the package integrity hash", async () => {
  const f = await setup();
  const path = join(f.repo, "plugins/sample");
  await chmod(join(path, "scripts/start.js"), 0o600);
  const before = await inspectPackage(path);
  await rename(join(path, "rules/style.md"), join(path, "rules/renamed.md"));
  expect((await inspectPackage(path)).hash).not.toBe(before.hash);
});

test.each([
  "sub/${PLUGIN_ROOT}",
  "${UNKNOWN}/sub",
  "${PLUGIN_ROOT}/../escape",
  "${PLUGIN_ROOT}/${PLUGIN_ROOT}",
])("MCP cwd %s cannot resolve relative to the workspace or escape the plugin", (cwd) => {
  expect(() =>
    importPlugin({
      "ace-plugin.json": JSON.stringify({
        schemaVersion: 1,
        name: "sample",
        version: "1",
        mcpServers: { tools: { type: "stdio", command: "node", cwd } },
      }),
    }),
  ).toThrow("MCP cwd must remain within the plugin root");
});

test("flat hook batches stop before appending more than 256 handlers", () => {
  expect(() =>
    importPlugin({
      ".claude-plugin/plugin.json": JSON.stringify({ name: "sample" }),
      "hooks/hooks.json": JSON.stringify({
        Stop: [
          { hooks: Array.from({ length: 256 }, () => ({ command: "echo safe" })) },
          { command: "echo exceeds" },
        ],
      }),
    }),
  ).toThrow("Import expansion limit");
});
test("empty repeated aliases still consume the bounded traversal budget", () => {
  const files: Record<string, string> = {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "sample", hooks: "alias-0.json" }),
    "leaf.json": "{}",
  };
  for (let index = 0; index < 10; index++) {
    const next = index === 9 ? "leaf.json" : `alias-${index + 1}.json`;
    files[`alias-${index}.json`] = JSON.stringify([next, next]);
  }
  expect(() => importPlugin(files)).toThrow("Import expansion limit");
});
test("a deep acyclic reference chain fails before exhausting the stack", () => {
  const files: Record<string, string> = {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "sample", hooks: "alias-0.json" }),
    "leaf.json": "{}",
  };
  for (let index = 0; index < 40; index++)
    files[`alias-${index}.json`] = JSON.stringify(
      index === 39 ? "leaf.json" : `alias-${index + 1}.json`,
    );
  expect(() => importPlugin(files)).toThrow("Import expansion limit");
});
