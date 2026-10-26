import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { GitError, GitService, spawnGitProcess } from "./index.ts";
import { git, put, repository, scalar, scratch } from "./test-repo.ts";

test.each(["add", "commit"])(
  "backup stops when permission is withdrawn during %s preparation",
  async (dispatch) => {
    const repo = await repository();
    const path = join(dirname(repo), "backup");
    const remote = join(dirname(repo), "remote.git");
    await git(repo, "init", "--bare", remote);
    await git(repo, "remote", "add", "origin", remote);
    let allowed = true;
    const service = new GitService({
      transportProtocols: ["file"],
      processRuntime: {
        spawn(command, args, options) {
          const child = spawnGitProcess(command, args, options);
          // Execution-key discovery is real asynchronous preparation inside cli.call.
          // Staging and commit carry distinct environments through this guarded query.
          if (
            args.includes("config") &&
            args.includes("--get-regexp") &&
            options.env?.GIT_LITERAL_PATHSPECS === "1" &&
            (options.env.GIT_TRACE2_EVENT === "1") === (dispatch === "commit")
          )
            child.once("close", () => {
              allowed = false;
            });
          return child;
        },
      },
    });
    try {
      await service.createWorktree({ repo, path, branch: "backup", baseRef: "HEAD" });
      await git(path, "push", "--quiet", "origin", "HEAD");
      const expectedHead = await scalar(path, "rev-parse", "HEAD");
      const index = await git(path, "ls-files", "--stage", "-z");
      await put(path, "tracked.txt", "edited\n");
      await expect(
        service.backupWorktree(repo, path, () => {
          if (!allowed) throw new GitError("git_cancelled", "Automatic backup was disabled");
        }),
      ).rejects.toMatchObject({
        code: "git_cancelled",
      });
      expect(allowed).toBe(false);
      expect(await scalar(path, "rev-parse", "HEAD")).toBe(expectedHead);
      if (dispatch === "commit") expect(await scalar(path, "show", ":tracked.txt")).toBe("edited");
      else expect(await git(path, "ls-files", "--stage", "-z")).toEqual(index);
      expect(await scalar(path, "diff", "HEAD", "--", "tracked.txt")).toContain("+edited");
      expect(await scalar(remote, "rev-parse", "refs/heads/backup")).toBe(expectedHead);
    } finally {
      await service.close();
    }
  },
);

test("permission withdrawn during credential preparation leaves the remote branch unchanged", async () => {
  const repo = await repository();
  const remote = join(await scratch(), "remote.git");
  await git(repo, "init", "--bare", remote);
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "--quiet", "origin", "HEAD");
  const branch = await scalar(repo, "branch", "--show-current");
  const published = await scalar(remote, "rev-parse", `refs/heads/${branch}`);
  await git(repo, "commit", "--allow-empty", "-m", "Unpublished work");
  const local = await scalar(repo, "rev-parse", "HEAD");
  let allowed = true;
  const service = new GitService({
    transportProtocols: ["file"],
    credentialHelperLookup: async () => {
      await Promise.resolve();
      allowed = false;
      return [];
    },
  });
  try {
    await expect(
      service.push({
        worktree: repo,
        remote: "origin",
        beforePush: () => {
          if (!allowed) throw new GitError("git_cancelled", "Automatic push was disabled");
        },
      }),
    ).rejects.toMatchObject({ code: "git_cancelled" });
    expect(allowed).toBe(false);
    expect(await scalar(remote, "rev-parse", `refs/heads/${branch}`)).toBe(published);
    expect(await scalar(repo, "rev-parse", "HEAD")).toBe(local);
    expect(await scalar(repo, "rev-parse", `refs/remotes/origin/${branch}`)).toBe(published);
  } finally {
    await service.close();
  }
});
