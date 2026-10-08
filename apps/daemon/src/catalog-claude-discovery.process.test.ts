import { expect, test } from "vitest";
import { mkdtemp, chmod, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverClaudePlugins } from "./catalog-claude-discovery.ts";
test("cold Claude plugin discovery uses only a registry read and keeps the current project's entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-claude-plugin-catalog-"));
  const executable = join(root, "claude"),
    log = join(root, "requests");
  const rows = [
    {
      id: "quality@fixture",
      enabled: true,
      scope: "user",
      installPath: join(root, "global-plugin"),
    },
    {
      id: "local@fixture",
      enabled: true,
      projectEnabled: true,
      scope: "project",
      projectPath: root,
      installPath: join(root, "local-plugin"),
    },
    {
      id: "foreign@fixture",
      enabled: true,
      scope: "project",
      projectPath: join(root, "other"),
      installPath: join(root, "foreign"),
    },
  ];
  await writeFile(
    executable,
    `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))); process.stdout.write(${JSON.stringify(JSON.stringify(rows))});\n`,
  );
  await chmod(executable, 0o755);
  try {
    const entries = await discoverClaudePlugins({
      executable,
      cwd: root,
      env: { ...process.env, HOME: root },
      signal: new AbortController().signal,
    });
    expect(entries.map((e) => ({ name: e.name, scope: e.source.scope }))).toEqual([
      { name: "quality", scope: "global" },
      { name: "local", scope: "project" },
    ]);
    expect(entries.every((e) => e.invocation.type === "unavailable")).toBe(true);
    expect(JSON.parse(await readFile(log, "utf8"))).toEqual(["plugin", "list", "--json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
