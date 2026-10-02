import { execFile } from "node:child_process";
import { chmod, cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, inject } from "vitest";
import { PROCESS_TEST_TIMEOUT } from "@ace/provider-kit/testing";

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
    timeout: PROCESS_TEST_TIMEOUT,
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
  // Copy only an empty initialized repository. Every test still creates its own
  // real initial commit and owns every subsequent index/ref/worktree mutation.
  await cp(inject("gitTemplate"), repo, { recursive: true });
  await Promise.all(Object.entries(files).map(([path, content]) => put(repo, path, content)));
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
  const [index, head, branchRefs, stashRef, stashLog] = await Promise.all([
    readFile(join(repo, ".git", "index")),
    readFile(join(repo, ".git", "HEAD")),
    git(repo, "show-ref", "--heads"),
    readFile(join(repo, ".git", "refs", "stash")),
    readFile(join(repo, ".git", "logs", "refs", "stash")),
  ]);
  return {
    index,
    head,
    branchRefs,
    stashRef,
    stashLog,
  };
}
