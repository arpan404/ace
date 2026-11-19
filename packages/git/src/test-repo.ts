import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, inject } from "vitest";
import { PROCESS_TEST_TIMEOUT } from "@ace/provider-kit/testing";
import { assertTestGitDirectory, testGitEnvironment } from "@ace/provider-kit/test-isolation";

export const execute = promisify(execFile);
/**
 * Arguments that run `body` as an ES module script whose work happens in an async function.
 * Bun neither fires beforeExit nor exits while a module's top-level await is pending, so a
 * script that waits for an idle barrier must not wait at the top level.
 */
export function idleBarrierScript(body: string): string[] {
  return [
    "--input-type=module",
    "--eval",
    `(async () => {\n${body}\n})().catch((error) => { console.error(error); process.exit(1); });`,
  ];
}
const directories: string[] = [];
// Captured once: a test may point TMPDIR elsewhere while its fixtures stay where they are.
const temporaryRoot = tmpdir();

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const templates: string[] = [];
afterAll(async () => {
  await Promise.all(
    templates.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function freshDirectory(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "ace-git-test-")));
}

export async function scratch(): Promise<string> {
  const directory = await freshDirectory();
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
  const output = await execute("git", args, {
    cwd: assertTestGitDirectory(repo, temporaryRoot),
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
    timeout: PROCESS_TEST_TIMEOUT,
    env: {
      ...testGitEnvironment(),
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      GIT_OPTIONAL_LOCKS: "0",
    },
  });
  return output.stdout;
}

/**
 * A real Git process working in `cwd` until stopped, like a person's own long-running `git`:
 * Git stays alive as the parent of the alias it runs.
 */
export async function holdGit(cwd: string) {
  const child = spawn("git", ["-c", "alias.hold=!sleep 300", "hold"], {
    cwd: assertTestGitDirectory(cwd, temporaryRoot),
    env: testGitEnvironment(),
    detached: true,
    stdio: "ignore",
  });
  await once(child, "spawn");
  const pid = child.pid;
  if (!pid) throw new Error("Holder Git did not start");
  const exited = once(child, "exit");
  let stopped = false;
  const stop = async () => {
    if (!stopped) process.kill(-pid, "SIGKILL");
    stopped = true;
    await exited;
  };
  holders.push(stop);
  return { pid, stop };
}
const holders: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(holders.splice(0).map((stop) => stop()));
});

export async function scalar(repo: string, ...args: string[]): Promise<string> {
  return (await git(repo, ...args)).toString().replace(/\n$/, "");
}

const defaultFiles = {
  "tracked.txt": "original\n",
  ".gitignore": "ignored/\n*.secret\n",
};

export async function repository(
  files: Record<string, string | Buffer> = defaultFiles,
): Promise<string> {
  return committedRepository(await scratch(), files);
}

/**
 * A committed repository built once per file (call it in `beforeAll`) and removed after the
 * file. Tests never use it directly: each takes its own `copyRepository` of it.
 */
export async function templateRepository(
  files: Record<string, string | Buffer> = defaultFiles,
): Promise<string> {
  const directory = await freshDirectory();
  templates.push(directory);
  return committedRepository(directory, files);
}

/** A private copy of a `templateRepository`, removed after the test. */
export async function copyRepository(template: string): Promise<string> {
  const repo = join(await scratch(), basename(template));
  await cp(template, repo, { recursive: true });
  return repo;
}

async function committedRepository(
  directory: string,
  files: Record<string, string | Buffer>,
): Promise<string> {
  if (process.platform === "win32") return windowsRepository(directory, files);
  const repo = join(directory, "repo with spaces\nand 雪");
  // Start from the shared empty initialized repository and make a real initial commit.
  await cp(inject("gitTemplate"), repo, { recursive: true });
  await Promise.all(Object.entries(files).map(([path, content]) => put(repo, path, content)));
  await git(repo, "add", "--all");
  await git(repo, "commit", "--allow-empty", "-m", "Initial");
  return repo;
}

/** Windows names can't hold control characters; the same fixture with spaces and Unicode. */
async function windowsRepository(directory: string, files: Record<string, string | Buffer>) {
  const repo = join(directory, "repo with spaces and 雪");
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
