import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { GitService, spawnGitProcess } from "./index.ts";
import { repository, scalar } from "./test-repo.ts";

const quote = (text: string) => "'" + text.replaceAll("'", "'\"'\"'") + "'";

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

test.each(["lazy-fetch suppression", "inherited transport denial"])(
  "a partial clone with a missing blob fails locally without executing SSH through %s",
  async (guard) => {
    const repo = await repository({ "tracked.txt": "Locally missing blob\n" });
    const marker = join(dirname(repo), "ssh-executed");
    const ssh = join(dirname(repo), "hostile-ssh.cjs");
    await writeFile(
      ssh,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); process.exit(1);\n`,
    );
    const blob = await scalar(repo, "rev-parse", "HEAD:tracked.txt");
    expect(await scalar(repo, "cat-file", "-t", blob)).toBe("blob");
    await scalar(repo, "config", "core.repositoryformatversion", "1");
    await scalar(repo, "config", "extensions.partialClone", "origin");
    await scalar(repo, "config", "remote.origin.url", "ssh://example.invalid/objects.git");
    await scalar(repo, "config", "remote.origin.promisor", "true");
    await scalar(repo, "config", "remote.origin.partialclonefilter", "blob:none");
    await scalar(repo, "config", "protocol.ssh.allow", "always");
    await scalar(repo, "config", "protocol.file.allow", "always");
    await scalar(repo, "config", "core.sshCommand", `${quote(process.execPath)} ${quote(ssh)}`);
    await rm(join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    const service = new GitService({
      processRuntime: {
        spawn: (command, args, options) => {
          const env = { ...options.env };
          // Exercise real Git's lazy-fetch fallback independently of environment support.
          if (guard === "inherited transport denial") delete env.GIT_NO_LAZY_FETCH;
          return spawnGitProcess(command, args, { ...options, env });
        },
      },
    });
    try {
      await expect(
        service.nonExecuting(() =>
          service.createWorktree({
            repo,
            path: join(dirname(repo), "partial-worktree"),
            branch: "partial-worktree",
            baseRef: "HEAD",
            signal: new AbortController().signal,
          }),
        ),
      ).rejects.toThrow(/objects not available locally/i);
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await service.nonExecuting(() => service.listWorktrees(repo))).map((tree) => tree.path),
      ).toEqual([repo]);
    } finally {
      await service.close();
    }
  },
);

test("authorized push and fetch from a protected checkout preserve hooks, fsmonitor and filter suppression", async () => {
  const repo = await repository({
    "tracked.txt": "Raw filtered bytes\n",
    ".gitattributes": "tracked.txt filter=hostile\n",
  });
  const remote = join(dirname(repo), "remote.git");
  await scalar(repo, "init", "--bare", remote);
  await scalar(repo, "remote", "add", "origin", `file://${remote}`);
  const marker = join(dirname(repo), "push-executed");
  const script = join(dirname(repo), "hostile.cjs");
  await writeFile(
    script,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); process.stdin.pipe(process.stdout);\n`,
  );
  const command = `${quote(process.execPath)} ${quote(script)}`;
  const hooks = join(dirname(repo), "hooks");
  await mkdir(hooks);
  for (const name of ["pre-push", "reference-transaction", "post-index-change"])
    await writeFile(join(hooks, name), `#!/bin/sh\nexec ${command}\n`, { mode: 0o755 });
  await scalar(repo, "config", "core.hooksPath", hooks);
  await scalar(repo, "config", "core.fsmonitor", command);
  for (const key of ["clean", "smudge", "process"])
    await scalar(repo, "config", `filter.hostile.${key}`, command);
  await scalar(repo, "config", "filter.hostile.required", "true");
  const service = new GitService({ transportProtocols: ["file"] });
  service.protectWorktree(repo);
  try {
    const head = await scalar(repo, "rev-parse", "HEAD");
    const branch = await scalar(repo, "symbolic-ref", "--short", "HEAD");
    await service.push({ worktree: repo, remote: "origin" });
    expect(await scalar(remote, "rev-parse", `refs/heads/${branch}`)).toBe(head);
    await service.fetchBranch({ repo, remote: "origin", branch, timeoutMs: 10000 });
    expect(await service.branchHead({ repo, remote: "origin", branch })).toBe(head);
    await writeFile(join(repo, "tracked.txt"), "Changed after push\n");
    expect((await service.status(repo)).unstaged).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "tracked.txt" })]),
    );
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await service.close();
  }
});
