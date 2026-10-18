import { access, cp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, inject, test } from "vitest";
import { testGitEnvironment } from "@ace/provider-kit/test-isolation";
import { GitService, spawnGitProcess } from "./index.ts";
import { execute, git, put, scalar, scratch } from "./test-repo.ts";

// Files a fixture just wrote are too fresh to trust (see `settleMs`); a file clock a little
// ahead lets these tests watch what a later read does without waiting for them to age.
const ahead = () => Date.now() + 10_000;

/**
 * A repository at a path without a newline: `rev-parse` names paths one per line, so a checkout
 * whose path holds one is (safely) never cached, and these tests watch what caching does.
 */
async function repository(
  files: Record<string, string> = { "tracked.txt": "original\n" },
): Promise<string> {
  const repo = join(await scratch(), "repo");
  await cp(inject("gitTemplate"), repo, { recursive: true });
  for (const [path, content] of Object.entries(files)) await put(repo, path, content);
  await git(repo, "add", "--all");
  await git(repo, "commit", "-m", "Initial");
  return repo;
}

/** A service recording every Git command it starts, without the `--no-pager` prefix. */
function recording(env: Record<string, string> = {}) {
  const commands: string[][] = [];
  const service = new GitService({
    processRuntime: {
      fileClock: ahead,
      spawn(command, args, spawnOptions) {
        commands.push(args.filter((arg) => arg !== "--no-pager"));
        return spawnGitProcess(command, args, {
          ...spawnOptions,
          env: { ...spawnOptions.env, ...env },
        });
      },
    },
  });
  /** The commands `operation` started. */
  const started = async (operation: () => Promise<unknown>) => {
    const before = commands.length;
    await operation();
    return commands.slice(before);
  };
  return { service, started };
}

/** A filter driver that leaves `executed` in the checkout when Git runs it. */
async function filtered(): Promise<string> {
  const repo = await repository({
    "filter.cjs":
      "require('node:fs').writeFileSync('executed', 'bad'); process.stdin.pipe(process.stdout);\n",
    ".gitattributes": "*.txt filter=planted\n",
    "tracked.txt": "original\n",
  });
  return repo;
}

/** Git would run the planted filter here: proof the fixture can actually execute it. */
async function expectFilterRunsUnguarded(repo: string, env: Record<string, string> = {}) {
  await execute("git", ["add", "tracked.txt"], {
    cwd: repo,
    env: { ...testGitEnvironment(), ...env },
  });
  await access(join(repo, "executed"));
}

/** Reads that pass the modified file through its clean filter unless the guard stops it. */
async function readChanges(service: GitService, repo: string) {
  await put(repo, "tracked.txt", "changed by the agent\n");
  expect((await service.changedFiles(repo)).files).toMatchObject([
    { path: "tracked.txt", status: "modified", additions: 1, deletions: 1 },
  ]);
  await expect(access(join(repo, "executed"))).rejects.toMatchObject({ code: "ENOENT" });
}

test("re-reading an unchanged checkout starts only git status", async () => {
  const repo = await repository();
  const { service, started } = recording();
  try {
    await service.status(repo);
    await service.status(repo);
    expect((await started(() => service.status(repo))).map((args) => args[0])).toEqual(["status"]);
  } finally {
    await service.close();
  }
});

test("re-reading an unchanged protected checkout reuses its execution guard instead of querying it again", async () => {
  const repo = await repository();
  const { service, started } = recording();
  service.protectWorktree(repo);
  try {
    await service.status(repo);
    await service.status(repo);
    const commands = await started(() => service.status(repo));
    expect(commands).toHaveLength(1);
    expect(commands[0]?.slice(0, 3)).toEqual(["-c", "protocol.allow=never", "status"]);
  } finally {
    await service.close();
  }
});

test("a thread's checkout summary reads branch, remotes and change counts with one git status", async () => {
  const repo = await repository();
  await scalar(repo, "remote", "add", "origin", "https://example.invalid/repo.git");
  await writeFile(join(repo, "tracked.txt"), "changed\n");
  await writeFile(join(repo, "new.txt"), "new\n");
  const { service, started } = recording();
  try {
    await service.checkoutSummary(repo);
    await service.checkoutSummary(repo);
    let summary: Awaited<ReturnType<GitService["checkoutSummary"]>> | undefined;
    const commands = await started(async () => {
      summary = await service.checkoutSummary(repo);
    });
    expect(commands.map((args) => args[0])).toEqual(["status", "diff"]);
    expect(summary).toMatchObject({
      info: {
        root: repo,
        branch: "main",
        remotes: [{ name: "origin", fetchUrls: ["https://example.invalid/repo.git"] }],
      },
      diff: { files: 2, additions: 1, deletions: 1 },
    });
  } finally {
    await service.close();
  }
});

test("a remote added after the checkout was read appears in the next read", async () => {
  const repo = await repository();
  const { service } = recording();
  try {
    expect((await service.repositoryInfo(repo)).remotes).toEqual([]);
    await service.repositoryInfo(repo);
    await scalar(repo, "remote", "add", "origin", "https://example.invalid/repo.git");
    expect((await service.repositoryInfo(repo)).remotes).toMatchObject([
      { name: "origin", fetchUrls: ["https://example.invalid/repo.git"] },
    ]);
  } finally {
    await service.close();
  }
});

test("a filter driver configured in a protected checkout after reads were reused never runs", async () => {
  const repo = await filtered();
  const { service } = recording();
  service.protectWorktree(repo);
  try {
    await service.changedFiles(repo);
    await service.changedFiles(repo);
    await scalar(repo, "config", "filter.planted.clean", "node filter.cjs");
    await readChanges(service, repo);
  } finally {
    await service.close();
  }
  await expectFilterRunsUnguarded(repo);
});

test("a filter driver in a config file an include named before it existed never runs", async () => {
  const repo = await filtered();
  await scalar(repo, "config", "include.path", "later.config");
  const { service } = recording();
  service.protectWorktree(repo);
  try {
    await service.changedFiles(repo);
    await service.changedFiles(repo);
    await writeFile(
      join(repo, ".git", "later.config"),
      '[filter "planted"]\n\tclean = node filter.cjs\n',
    );
    await readChanges(service, repo);
  } finally {
    await service.close();
  }
  await expectFilterRunsUnguarded(repo);
});

test("a filter driver in a global config file created after reads were reused never runs", async () => {
  const repo = await filtered();
  const isolated = { GIT_CONFIG_GLOBAL: join(await scratch(), "global") };
  const { service } = recording(isolated);
  service.protectWorktree(repo);
  try {
    await service.changedFiles(repo);
    await service.changedFiles(repo);
    await writeFile(isolated.GIT_CONFIG_GLOBAL, '[filter "planted"]\n\tclean = node filter.cjs\n');
    await readChanges(service, repo);
  } finally {
    await service.close();
  }
  await expectFilterRunsUnguarded(repo, isolated);
});

test("with no Git configured, calls start the executable the platform locates", async () => {
  const repo = await repository();
  const located = join(await scratch(), "located-git");
  await writeFile(located, `#!/bin/sh\nexec git "$@"\n`, { mode: 0o755 });
  const binaries = new Set<string>();
  const service = new GitService({
    processRuntime: {
      locateGit: async () => located,
      spawn(command, args, options) {
        binaries.add(command);
        return spawnGitProcess(command, args, options);
      },
    },
  });
  try {
    expect((await service.repositoryInfo(repo)).branch).toBe("main");
    expect([...binaries]).toEqual([located]);
  } finally {
    await service.close();
  }
});

test("a configured Git binary is started as configured, never replaced by a located one", async () => {
  const repo = await repository();
  const configured = join(await scratch(), "configured-git");
  await writeFile(configured, `#!/bin/sh\nexec git "$@"\n`, { mode: 0o755 });
  const binaries = new Set<string>();
  const service = new GitService({
    gitBinary: configured,
    processRuntime: {
      locateGit: async () => "/nonexistent/git",
      spawn(command, args, options) {
        binaries.add(command);
        return spawnGitProcess(command, args, options);
      },
    },
  });
  try {
    await service.status(repo);
    expect([...binaries]).toEqual([configured]);
  } finally {
    await service.close();
  }
});

test("a located Git that disappears is located again on the next call", async () => {
  const repo = await repository();
  const located = join(await scratch(), "located-git");
  await writeFile(located, `#!/bin/sh\nexec git "$@"\n`, { mode: 0o755 });
  let location: string | undefined = located;
  const service = new GitService({
    processRuntime: { locateGit: async () => location },
  });
  try {
    await service.status(repo);
    await rm(located);
    location = undefined;
    await expect(service.status(repo)).rejects.toMatchObject({ code: "git_missing" });
    expect((await service.repositoryInfo(repo)).branch).toBe("main");
  } finally {
    await service.close();
  }
});
