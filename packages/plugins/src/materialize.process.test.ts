import { lstat, mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { materializeProjection, projectPlugins, removeProjection } from "./index.ts";
import type { Provider } from "./index.ts";
import { fixture, fingerprint, writeFiles } from "./test-support.ts";

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

test("reprojection removes deleted capabilities and cleanup removes every generated file", async () => {
  const f = await setup();
  const root = join(f.root, "projection");
  const snapshots = await f.manager.installed();
  await materializeProjection(projectPlugins("cursor", snapshots, { root }), { root });
  await materializeProjection(projectPlugins("cursor", [], { root }), { root });
  expect(await readdir(join(root, "generated"))).toEqual([]);
  await removeProjection(root);
  await expect(lstat(join(root, "generated"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readdir(root)).toSorted()).toEqual([".ace-plugins-owned", "operation.sqlite"]);
});
test("source tampering fails replacement while the previous generated configuration remains usable", async () => {
  const f = await setup();
  const root = join(f.root, "projection");
  const snapshots = await f.manager.installed();
  const projection = projectPlugins("claude", snapshots, { root });
  await materializeProjection(projection, { root });
  const before = await fingerprint(join(root, "generated/mcp.json"));
  await writeFile(join(snapshots[0]?.root ?? "", "scripts/server.js"), "tampered");
  await expect(materializeProjection(projection, { root })).rejects.toThrow("Integrity mismatch");
  expect(await fingerprint(join(root, "generated/mcp.json"))).toBe(before);
  expect(await readdir(root)).not.toContain(".ace-writing");
});
test("a crash between projection renames restores the previous output before the next write", async () => {
  const f = await setup();
  const root = join(f.root, "projection");
  const projection = projectPlugins("claude", await f.manager.installed(), { root });
  await materializeProjection(projection, { root });
  await rename(join(root, "generated"), join(root, ".ace-previous"));
  await mkdir(join(root, ".ace-writing"));
  await materializeProjection(projection, { root });
  expect(await readFile(join(root, "generated/instructions.md"), "utf8")).toBe("Use TypeScript.");
  expect(await readdir(root)).not.toContain(".ace-previous");
});
test("projection paths and symlinks cannot escape into user files", async () => {
  const f = await setup();
  const root = join(f.root, "projection");
  const projection = projectPlugins("claude", await f.manager.installed(), { root });
  await materializeProjection(projection, { root });
  projection.files.push({
    path: "generated/../../user/config.json",
    content: "bad",
    executable: false,
  });
  await expect(materializeProjection(projection, { root })).rejects.toThrow();
  await symlink(join(f.repo, "plugins/sample"), join(root, "generated/escape"));
  await expect(
    materializeProjection(projectPlugins("claude", [], { root }), { root }),
  ).rejects.toThrow("Symlink");
});
test.each<Provider>(["claude", "codex", "opencode", "cursor", "acp", "antigravity"])(
  "%s install, projection, update and removal leave user configuration hashes unchanged",
  async (provider) => {
    const f = await setup();
    const user = join(f.root, "user");
    const files = {
      ".claude/settings.json": '{"hooks":{}}',
      ".codex/config.toml": 'model="user-model"',
      ".cursor/mcp.json": '{"mcpServers":{}}',
      ".config/opencode/opencode.json": '{"theme":"user"}',
    };
    await writeFiles(user, files);
    const before = await Promise.all(
      Object.keys(files).map((path) => fingerprint(join(user, path))),
    );
    const root = join(f.root, `owned-${provider}`);
    await materializeProjection(projectPlugins(provider, await f.manager.installed(), { root }), {
      root,
    });
    await f.manager.accept(await f.manager.update("sample"));
    await f.manager.remove("sample");
    await removeProjection(root);
    expect(
      await Promise.all(Object.keys(files).map((path) => fingerprint(join(user, path)))),
    ).toEqual(before);
    await expect(
      materializeProjection(
        {
          env: {},
          args: [],
          files: [{ path: "generated/bad", executable: false, content: "bad" }],
          sessionConfig: {},
          unsupported: [],
        },
        { root: join(user, ".claude") },
      ),
    ).rejects.toThrow("nonempty");
    expect(
      await Promise.all(Object.keys(files).map((path) => fingerprint(join(user, path)))),
    ).toEqual(before);
  },
);
test("content with provider placeholders resolves as data even when the owned root has dollar characters", async () => {
  const f = await setup();
  const snapshots = await f.manager.installed();
  const plugin = snapshots[0];
  if (!plugin) throw new Error("Missing fixture");
  plugin.manifest.hooks = [{ event: "Stop", command: "echo ${PLUGIN_ROOT}" }];
  const root = join(f.root, "$& root");
  const projection = projectPlugins("claude", snapshots, { root });
  await materializeProjection(projection, { root });
  expect(await json(join(root, "generated/plugins/sample/hooks/hooks.json"))).toEqual({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "echo ${CLAUDE_PLUGIN_ROOT}/payload" }] }],
    },
  });
});
