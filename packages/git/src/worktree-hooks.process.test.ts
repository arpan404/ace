import { access, mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, repository, scalar } from "./test-repo.ts";

for (const staged of [false, true]) {
  test(`${staged ? "batched" : "ordinary"} worktree checkout and cleanup suppress configured repository hooks`, async () => {
    const repo = await repository();
    const path = join(dirname(repo), "untrusted-checkout");
    const hooks = join(repo, "configured-hooks");
    const marker = join(dirname(repo), "hook-executed");
    await mkdir(hooks);
    for (const name of ["post-checkout", "post-index-change", "reference-transaction"])
      await writeFile(join(hooks, name), `#!/bin/sh\nprintf executed > '${marker}'\n`, {
        mode: 0o755,
      });
    await git(repo, "config", "core.hooksPath", hooks);
    const service = new GitService();
    try {
      const head = await scalar(repo, "rev-parse", "HEAD");
      await service.createWorktree({
        repo,
        path,
        baseRef: head,
        branch: "untrusted",
        ...(staged ? { signal: new AbortController().signal } : {}),
      });
      expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe("original\n");
      expect(await scalar(path, "rev-parse", "HEAD")).toBe(head);
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      await service.removeWorktree({ repo, path });
      await service.deleteBranch({ repo, branch: "untrusted", expectedHead: head });
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await scalar(repo, "config", "core.hooksPath")).toBe(hooks);
    } finally {
      await service.close();
    }
  });
}
