import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { testGitEnvironment } from "@ace/provider-kit/test-isolation";
import { GitService } from "./index.ts";

const execute = promisify(execFile);

async function run(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute("git", args, {
    cwd,
    env: { ...testGitEnvironment(), GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  });
  return stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

describe.runIf(process.platform === "win32")("Windows hook suppression", () => {
  test("hooks planted where Git for Windows reads /dev/null never run during commit or worktree work", async (context) => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "ace-git-hooks-test-")));
    // Git for Windows resolves `/dev/null/<hook>` against the current drive's root.
    const planted = join(win32.parse(base).root, "dev", "null");
    if (await exists(planted)) context.skip(`${planted} already exists; refusing to modify it`);
    const marker = join(base, "hook-ran");
    // The first folder this test creates; only that subtree is removed afterwards.
    let created: string | undefined;
    try {
      created = await mkdir(planted, { recursive: true });
      const script = `#!/bin/sh\necho ran >> '${marker.replaceAll("\\", "/")}'\n`;
      for (const hook of ["pre-commit", "post-commit", "reference-transaction", "post-checkout"])
        await writeFile(join(planted, hook), script);
      const repo = join(base, "repo");
      await mkdir(repo);
      await run(repo, "init", "--initial-branch=main");
      await run(repo, "config", "user.name", "Test");
      await run(repo, "config", "user.email", "test@example.com");
      await writeFile(join(repo, "tracked.txt"), "first\n");
      await run(repo, "add", "--all");
      // Control: the drive-root folder is where plain `core.hooksPath=/dev/null` looks.
      await run(repo, "-c", "core.hooksPath=/dev/null", "commit", "-m", "Initial");
      expect(await exists(marker)).toBe(true);
      await rm(marker);
      const initial = await run(repo, "rev-parse", "HEAD");

      const service = new GitService({ credentialHelperLookup: async () => [] });
      service.protectWorktree(repo);
      try {
        await writeFile(join(repo, "tracked.txt"), "second\n");
        const committed = await service.commit({
          worktree: repo,
          message: "Protected commit",
          expectedHead: initial,
        });
        expect(committed).not.toBe(initial);
        const fork = join(base, "fork");
        await service.createWorktree({ repo, path: fork, branch: "fork", baseRef: "HEAD" });
        await service.removeWorktree({ repo, path: fork });
      } finally {
        await service.close();
      }
      expect(await exists(marker)).toBe(false);
    } finally {
      if (created !== undefined) await rm(created, { recursive: true, force: true });
      await rm(base, { recursive: true, force: true });
    }
  });
});
