import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, repository, scalar } from "./test-repo.ts";

test("retained protected worktrees can fetch and push through injected local transports without executing repository programs", async () => {
  const repo = await repository();
  const home = dirname(repo);
  const remote = join(home, "remote.git");
  const path = join(home, "protected");
  const marker = join(home, "executed");
  const script = join(repo, "a-hostile.cjs");
  await writeFile(
    script,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`,
  );
  await writeFile(join(repo, ".gitattributes"), "tracked.txt filter=review\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "Untrusted checkout programs");
  await git(home, "clone", "--bare", "--", repo, remote);
  await git(repo, "remote", "add", "origin", remote);
  const hooks = join(repo, ".githooks");
  await mkdir(hooks);
  for (const name of ["post-index-change", "pre-push"]) {
    const hook = join(hooks, name);
    await writeFile(
      hook,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'hook');\n`,
    );
    await chmod(hook, 0o755);
  }
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
  await git(repo, "config", "core.hooksPath", hooks);
  await git(repo, "config", "core.fsmonitor", command);
  await git(repo, "config", "filter.review.process", command);
  await git(repo, "config", "filter.review.smudge", command);
  await git(repo, "config", "filter.review.required", "true");
  const service = new GitService({ transportProtocols: ["file"] });
  try {
    await service.nonExecuting(() =>
      service.createWorktree({ repo, path, branch: "protected-review", baseRef: "HEAD" }),
    );
    service.protectWorktree(path);
    await service.fetchBranch({ repo: path, remote: "origin", branch: "main", timeoutMs: 60_000 });
    expect(await service.branchHead({ repo: path, remote: "origin", branch: "main" })).toBe(
      await scalar(remote, "rev-parse", "refs/heads/main"),
    );
    await service.push({ worktree: path, remote: "origin" });
    expect(await scalar(remote, "rev-parse", "refs/heads/protected-review")).toBe(
      await scalar(repo, "rev-parse", "HEAD"),
    );
    expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe("original\n");
    await service.status(path);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await service.close();
  }
});

test("production transfer admission refuses file and ext even when repository configuration allows them", async () => {
  const repo = await repository();
  const home = dirname(repo);
  const remote = join(home, "remote.git");
  const marker = join(home, "ext-executed");
  const script = join(home, "remote.cjs");
  await writeFile(
    script,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`,
  );
  await git(home, "clone", "--bare", "--", repo, remote);
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "remote", "add", "hostile", `ext::${process.execPath} ${script}`);
  await git(repo, "config", "protocol.file.allow", "always");
  await git(repo, "config", "protocol.ext.allow", "always");
  const service = new GitService();
  service.protectWorktree(repo);
  try {
    for (const name of ["origin", "hostile"]) {
      await expect(
        service.fetchBranch({ repo, remote: name, branch: "main", timeoutMs: 60_000 }),
      ).rejects.toThrow();
      await expect(service.push({ worktree: repo, remote: name })).rejects.toThrow();
    }
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await service.close();
  }
});
