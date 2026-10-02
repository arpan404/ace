import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, vi } from "vitest";

// Contain failed real processes without imposing a performance budget on Git tests.
vi.setConfig({ testTimeout: 30_000 });

export const execute = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

export async function scratch(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "ace-git-test-")));
  directories.push(directory);
  return directory;
}

export async function proxyGit(intercept: string): Promise<string> {
  const directory = await scratch();
  const binary = join(directory, "git-proxy.cjs");
  await writeFile(
    binary,
    `#!${process.execPath}
    const { spawn, spawnSync } = require('node:child_process');
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    ${intercept}
    const child = spawn('git', args, { stdio: 'inherit', shell: false });
    child.on('error', () => process.exit(70));
    child.on('close', code => process.exit(code ?? 71));
  `,
  );
  await chmod(binary, 0o755);
  return binary;
}

export async function git(repo: string, ...args: string[]): Promise<Buffer> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const output = await execute("git", args, {
    cwd: repo,
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
    env: { ...env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" },
  });
  return output.stdout;
}

export async function scalar(repo: string, ...args: string[]): Promise<string> {
  return (await git(repo, ...args)).toString().replace(/\n$/, "");
}

export async function repository(
  files: Record<string, string | Buffer> = {
    "tracked.txt": "original\n",
    ".gitignore": "ignored/\n*.secret\n",
  },
): Promise<string> {
  const directory = await scratch();
  const repo = join(directory, "repo with spaces\nand 雪");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@example.invalid");
  await git(repo, "config", "commit.gpgsign", "false");
  for (const [path, content] of Object.entries(files)) await put(repo, path, content);
  await git(repo, "add", "--all");
  await git(repo, "commit", "--allow-empty", "-m", "Initial");
  return repo;
}

export async function put(repo: string, path: string, content: string | Buffer): Promise<void> {
  const absolute = join(repo, path);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content);
}

export async function userState(repo: string) {
  return {
    index: await readFile(join(repo, ".git", "index")),
    head: await readFile(join(repo, ".git", "HEAD")),
    branchRefs: await git(repo, "show-ref", "--heads"),
    stashRef: await readFile(join(repo, ".git", "refs", "stash")),
    stashLog: await readFile(join(repo, ".git", "logs", "refs", "stash")),
  };
}
