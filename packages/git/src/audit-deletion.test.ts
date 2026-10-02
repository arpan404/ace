import { watch } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { proxyGit, repository, scalar, scratch } from "./test-repo.ts";

test.each(["present", "absent"])(
  "deletion rejects a concurrent linked-worktree allocation when the counter was %s",
  async (counter) => {
    const repo = await repository();
    const service = new GitService();
    const first =
      counter === "present"
        ? await service.createCheckpoint({ worktree: repo, threadId: "race", label: "first" })
        : undefined;
    const directory = await scratch();
    const linked = join(directory, "linked");
    await service.createWorktree({ repo, path: linked, baseRef: "HEAD", branch: "linked" });
    const reached = Promise.withResolvers<void>();
    const watcher = watch(directory, (_event, name) => {
      if (name === "ready") reached.resolve();
    });
    const binary =
      await proxyGit(`if (args.includes('for-each-ref') && args.includes('refs/ace/checkpoints/race/')) {
    const result = spawnSync('git', args);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    const watcher = fs.watch(${JSON.stringify(directory)}, (_event, name) => {
      if (name === 'release') { watcher.close(); process.exit(result.status ?? 71); }
    });
    fs.writeFileSync(${JSON.stringify(join(directory, "ready"))}, 'ready');
    return;
  }`);
    const deletion = new GitService({ gitBinary: binary }).deleteCheckpoints({
      repo,
      threadId: "race",
    });
    const rejected = expect(deletion).rejects.toMatchObject({ code: "git_failed" });
    try {
      await reached.promise;
      const second = await service.createCheckpoint({
        worktree: linked,
        threadId: "race",
        label: "concurrent",
      });
      await writeFile(join(directory, "release"), "release");
      await rejected;
      expect(await service.listCheckpoints({ repo, threadId: "race" })).toEqual(
        first ? [first, second] : [second],
      );
      expect(await scalar(repo, "rev-parse", "refs/ace/checkpoint-sequences/race")).toBe(
        second.sha,
      );
      expect(await service.deleteCheckpoints({ repo, threadId: "race" })).toEqual({
        deleted: first ? 2 : 1,
      });
      expect(await scalar(repo, "for-each-ref", "--format=%(refname)", "refs/ace/")).toBe("");
    } finally {
      watcher.close();
      await writeFile(join(directory, "release"), "release");
      await deletion.catch(() => {});
    }
  },
);
