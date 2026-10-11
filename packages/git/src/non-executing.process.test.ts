import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { GitService, spawnGitProcess } from "./index.ts";
import { repository, scalar } from "./test-repo.ts";

test("non-executing checkout disables global clean, smudge and LFS process drivers and preserves raw blob contents", async () => {
  const repo = await repository({
    "a-filter.cjs":
      "require('node:fs').writeFileSync('executed', 'bad'); process.stdin.pipe(process.stdout);\n",
    "a-lfs.cjs": "require('node:fs').writeFileSync('executed', 'bad'); process.exit(1);\n",
    ".gitattributes": "ordinary.txt filter=review\npointer.txt filter=lfs\n",
    "ordinary.txt": "Raw blob\n",
    "pointer.txt": "An LFS pointer stays a pointer\n",
  });
  const home = dirname(repo);
  const global = join(home, "global-config");
  await writeFile(
    global,
    '[filter "review"]\nclean = node a-filter.cjs\nsmudge = node a-filter.cjs\nrequired = true\n[filter "lfs"]\nprocess = node a-lfs.cjs\nrequired = true\n',
  );
  const service = new GitService({
    processRuntime: {
      spawn: (command, args, options) =>
        spawnGitProcess(command, args, {
          ...options,
          env: { ...options.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: "1" },
        }),
    },
  });
  const path = join(home, "fork");
  try {
    await service.nonExecuting(async () => {
      await service.createWorktree({
        repo,
        path,
        branch: "fork",
        baseRef: "HEAD",
        signal: new AbortController().signal,
      });
      expect(await readFile(join(path, "ordinary.txt"), "utf8")).toBe("Raw blob\n");
      expect(await readFile(join(path, "pointer.txt"), "utf8")).toBe(
        "An LFS pointer stays a pointer\n",
      );
      await expect(access(join(path, "executed"))).rejects.toMatchObject({ code: "ENOENT" });
      await service.removeWorktree({ repo, path });
      await service.deleteBranch({
        repo,
        branch: "fork",
        expectedHead: await scalar(repo, "rev-parse", "HEAD"),
      });
    });
    await expect(access(join(repo, "executed"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await service.close();
  }
});

test("a protected checkout keeps hooks and fsmonitor disabled outside the preparation scope, including descendants", async () => {
  const repo = await repository();
  const marker = join(dirname(repo), "executed");
  const hooks = join(repo, ".githooks");
  await mkdir(hooks);
  await writeFile(join(hooks, "post-index-change"), `#!/bin/sh\nprintf executed > '${marker}'\n`, {
    mode: 0o755,
  });
  await writeFile(
    join(repo, "monitor.cjs"),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); process.stdout.write('token\\0');\n`,
  );
  // Configure Git without using the policy under test. These commands do not touch its index.
  await scalar(repo, "config", "core.hooksPath", ".githooks");
  await scalar(repo, "config", "core.fsmonitor", "node monitor.cjs");
  const service = new GitService();
  service.protectWorktree(repo);
  try {
    await writeFile(join(repo, "tracked.txt"), "Changed\n");
    await mkdir(join(repo, "nested"));
    expect((await service.status(join(repo, "nested"))).unstaged).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "tracked.txt" })]),
    );
    await expect(
      service.setupWorktree({ worktree: repo, command: "node monitor.cjs" }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await service.close();
  }
});
