import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { PluginManager } from "./index.ts";

const execute = promisify(execFile);
export const sampleManifest = {
  schemaVersion: 1,
  name: "sample",
  version: "1.0",
  description: "Project conventions",
  skills: [{ name: "review", path: "skills/review" }],
  commands: [{ name: "check", path: "commands/check.md" }],
  agents: [{ name: "reviewer", path: "agents/reviewer.md", description: "Review code" }],
  rules: [{ name: "style", path: "rules/style.md" }],
  hooks: [
    { event: "SessionStart", command: "node ${PLUGIN_ROOT}/scripts/start.js", matcher: "startup" },
  ],
  mcpServers: {
    tools: {
      type: "stdio",
      command: "node",
      args: ["${PLUGIN_ROOT}/scripts/server.js", 'a quote: "'],
      env: { MODE: "local" },
    },
    docs: { type: "http", url: "https://example.com/mcp", headers: { "X-Mode": "test" } },
  },
};
export const sampleFiles: Record<string, string> = {
  "ace-plugin.json": JSON.stringify(sampleManifest),
  "skills/review/SKILL.md":
    "---\nname: review\ndescription: Review changes\n---\nCheck the behavior.\n",
  "skills/review/references/checklist.md": "Check failure behavior.",
  "commands/check.md": "---\ndescription: Check changes\n---\nRun checks $ARGUMENTS",
  "agents/reviewer.md":
    "---\nname: reviewer\ndescription: Review code\n---\nReview behavior and failure paths.",
  "rules/style.md": "Use TypeScript.",
  "scripts/start.js": "throw new Error('must not execute at install time');",
  "scripts/server.js": "throw new Error('must not execute at install time');",
};
export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}
export async function git(root: string, args: string[]): Promise<string> {
  const result = await execute("git", args, {
    cwd: root,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  return result.stdout.trim();
}
export async function fixture(files: Record<string, string> = sampleFiles) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-plugins-test-")));
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await writeFiles(repo, {
    "marketplace.json": JSON.stringify({
      name: "test-market",
      plugins: [{ name: "sample", source: "./plugins/sample" }],
    }),
  });
  await writeFiles(join(repo, "plugins/sample"), files);
  if (files["scripts/start.js"] !== undefined)
    await chmod(join(repo, "plugins/sample/scripts/start.js"), 0o755);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "fixture"]);
  const managerRoot = join(root, "ace");
  const options = { root: managerRoot, now: () => 123, id: randomUUID };
  let manager: PluginManager;
  try {
    manager = await PluginManager.open(options);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    repo,
    managerRoot,
    get manager() {
      return manager;
    },
    prepare: () => manager.prepare({ repository: repo, ref: "main", name: "sample" }),
    reopen: async () => {
      manager.close();
      manager = await PluginManager.open(options);
    },
    close: async () => {
      manager.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
export async function fingerprint(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
