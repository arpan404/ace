import { access, rm, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { GitService, spawnGitProcess } from "./index.ts";
import { git, repository, scalar } from "./test-repo.ts";

test("a protected partial-clone checkout never launches a promisor SSH command for a missing blob", async () => {
  const repo = await repository();
  const parent = dirname(repo);
  const marker = join(parent, "lazy-fetch-executed");
  const command = join(parent, "hostile-ssh.cjs");
  await writeFile(
    command,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); process.exit(1);\n`,
  );
  const blob = await scalar(repo, "rev-parse", "HEAD:tracked.txt");
  await scalar(repo, "remote", "add", "origin", "ssh://lazy-fetch.invalid/repo.git");
  await scalar(repo, "config", "core.repositoryFormatVersion", "1");
  await scalar(repo, "config", "extensions.partialClone", "origin");
  await scalar(repo, "config", "remote.origin.promisor", "true");
  await scalar(repo, "config", "protocol.ssh.allow", "always");
  await scalar(repo, "config", "protocol.file.allow", "always");
  await scalar(repo, "config", "remote.origin.partialclonefilter", "blob:none");
  await scalar(
    repo,
    "config",
    "core.sshCommand",
    `${JSON.stringify(process.execPath)} ${JSON.stringify(command)}`,
  );
  await rm(join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  const service = new GitService({
    processRuntime: {
      spawn(command, args, options) {
        // Exercise the backstop on Git versions which ignore GIT_NO_LAZY_FETCH.
        const env = { ...options.env };
        delete env.GIT_NO_LAZY_FETCH;
        return spawnGitProcess(command, args, { ...options, env });
      },
    },
  });
  try {
    await expect(
      service.nonExecuting(() =>
        service.createWorktree({
          repo,
          path: join(parent, "protected-partial"),
          branch: "safe-partial",
          baseRef: "HEAD",
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toMatchObject({
      code: "objects_not_available",
      message: "Objects not available locally",
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    // A separate control marker proves that an unprotected lookup launches the transport.
    const controlMarker = join(parent, "unprotected-control");
    await writeFile(
      command,
      `require('node:fs').writeFileSync(${JSON.stringify(controlMarker)}, 'executed'); process.exit(1);\n`,
    );
    await expect(git(repo, "cat-file", "blob", blob)).rejects.toThrow();
    expect(await access(controlMarker)).toBeUndefined();
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await service.close();
  }
});

test("explicit PR fetch supplies partial-clone blobs before a non-executing checkout", async () => {
  const publisher = await repository();
  const parent = dirname(publisher);
  const source = join(parent, "origin.git");
  const repo = join(parent, "partial-project");
  await git(parent, "clone", "--bare", "--", publisher, source);
  await git(source, "config", "uploadpack.allowFilter", "true");
  const head = await scalar(publisher, "rev-parse", "HEAD");
  await git(source, "update-ref", "refs/pull/7/head", head);
  await git(parent, "clone", "--filter=blob:none", "--no-checkout", "--", `file://${source}`, repo);
  const service = new GitService({ transportProtocols: ["file"] });
  const path = join(parent, "materialized-pr");
  try {
    await service.nonExecuting(async () => {
      expect(
        await service.fetchPrHead({ repo, remote: "origin", number: 7, timeoutMs: 60_000 }),
      ).toBe(head);
      await service.createWorktree({
        repo,
        path,
        branch: "materialized-pr",
        baseRef: head,
        signal: new AbortController().signal,
      });
      service.protectWorktree(path);
    });
    expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe("original\n");
    expect(
      await service.fetchPrHead({ repo: path, remote: "origin", number: 7, timeoutMs: 60_000 }),
    ).toBe(head);
  } finally {
    await service.close();
  }
});
