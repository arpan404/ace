import { readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { GitService } from "./index.ts";
import {
  execute,
  git,
  proxyGit,
  put,
  repository,
  scalar,
  scratch,
  userState,
} from "./test-repo.ts";

const service = new GitService();

describe("checkpoints", () => {
  test("assume-unchanged and skip-worktree flags do not hide working changes", async () => {
    const repo = await repository({ "assumed.txt": "original\n", "skipped.txt": "original\n" });
    await git(repo, "update-index", "--assume-unchanged", "assumed.txt");
    await git(repo, "update-index", "--skip-worktree", "skipped.txt");
    await put(repo, "assumed.txt", "changed assumed\n");
    await put(repo, "skipped.txt", "changed skipped\n");
    const index = await readFile(join(repo, ".git", "index"));
    const checkpoint = await service.createCheckpoint({
      worktree: repo,
      threadId: "flags",
      label: "working contents",
    });
    expect((await git(repo, "show", `${checkpoint.sha}:assumed.txt`)).toString()).toBe(
      "changed assumed\n",
    );
    expect((await git(repo, "show", `${checkpoint.sha}:skipped.txt`)).toString()).toBe(
      "changed skipped\n",
    );
    expect(await readFile(join(repo, ".git", "index"))).toEqual(index);
  });

  test("snapshots preserve the index bytes, HEAD, branch refs and stash bytes", async () => {
    const repo = await repository();
    await put(repo, "tracked.txt", "stashed\n");
    await git(repo, "stash", "push", "-m", "Keep my stash");
    await put(repo, "tracked.txt", "staged\n");
    await git(repo, "add", "tracked.txt");
    await put(repo, "tracked.txt", "working content\n");
    const before = await userState(repo);
    const checkpoint = await service.createCheckpoint({
      worktree: repo,
      threadId: "thread-1",
      label: "turn start\n雪",
    });
    expect(await userState(repo)).toEqual(before);
    expect((await git(repo, "show", `${checkpoint.sha}:tracked.txt`)).toString()).toBe(
      "working content\n",
    );
    expect(await scalar(repo, "rev-parse", checkpoint.id)).toBe(checkpoint.sha);
    expect(await service.listCheckpoints({ repo, threadId: "thread-1" })).toEqual([checkpoint]);
  });

  test("untracked paths are captured while untracked ignored files are excluded", async () => {
    const repo = await repository();
    const unusual = "dir with spaces/new\n雪\tfile.txt";
    await put(repo, unusual, "untracked\n");
    await put(repo, "ignored/private.txt", "private\n");
    await put(repo, "token.secret", "secret\n");
    const checkpoint = await service.createCheckpoint({
      worktree: repo,
      threadId: "files",
      label: "all files",
    });
    expect(
      (await git(repo, "ls-tree", "-r", "--name-only", "-z", checkpoint.sha))
        .toString()
        .split("\0")
        .filter(Boolean),
    ).toEqual([".gitignore", unusual, "tracked.txt"]);
    expect((await git(repo, "show", `${checkpoint.sha}:${unusual}`)).toString()).toBe(
      "untracked\n",
    );
    expect(await service.status(repo)).toMatchObject({
      staged: [],
      unstaged: [],
      untracked: [unusual],
      conflicted: [],
    });
  });

  test("force-added ignored files and files whose deletion is staged remain in the snapshot", async () => {
    const repo = await repository({
      ".gitignore": "*.secret\n",
      "tracked.secret": "tracked ignored\n",
    });
    // Initial add respects ignores, so explicitly track this path now.
    await git(repo, "add", "-f", "tracked.secret");
    await git(repo, "commit", "-m", "Track secret");
    await git(repo, "rm", "--cached", "tracked.secret");
    await put(repo, "added.secret", "staged ignored\n");
    await git(repo, "add", "-f", "added.secret");
    const index = await readFile(join(repo, ".git", "index"));
    const checkpoint = await service.createCheckpoint({
      worktree: repo,
      threadId: "tracked",
      label: "tracked ignores",
    });
    expect((await git(repo, "show", `${checkpoint.sha}:tracked.secret`)).toString()).toBe(
      "tracked ignored\n",
    );
    expect((await git(repo, "show", `${checkpoint.sha}:added.secret`)).toString()).toBe(
      "staged ignored\n",
    );
    expect(await readFile(join(repo, ".git", "index"))).toEqual(index);
  });

  test("two concurrent checkpoints across service instances allocate distinct refs", async () => {
    const repo = await repository();
    await put(repo, "new.txt", "new\n");
    // Delay first discovery until the second call has completed. Call arrival does
    // not define lock-entry order, because discovery itself performs real I/O.
    const gate = await scratch();
    const ready = Promise.withResolvers<void>();
    const watcher = watch(gate, (_event, name) => {
      if (name === "ready") ready.resolve();
    });
    const binary =
      await proxyGit(`if (args.includes('worktree') && args.includes('list') && !fs.existsSync(${JSON.stringify(join(gate, "open"))})) {
      const watcher = fs.watch(${JSON.stringify(gate)}, () => {
        if (!fs.existsSync(${JSON.stringify(join(gate, "open"))})) return;
        watcher.close();
        const child = spawn('git',args,{stdio:'inherit',shell:false});
        child.on('close',code=>process.exit(code ?? 71));
      });
      fs.writeFileSync(${JSON.stringify(join(gate, "ready"))}, 'ready');
      return;
    }`);
    const first = new GitService({ gitBinary: binary }).createCheckpoint({
      worktree: repo,
      threadId: "concurrent",
      label: "first",
    });
    let a;
    let b;
    try {
      await ready.promise;
      b = await service.createCheckpoint({
        worktree: repo,
        threadId: "concurrent",
        label: "second",
      });
      await writeFile(join(gate, "open"), "open");
      a = await first;
    } finally {
      watcher.close();
    }
    expect(a.id).not.toBe(b.id);
    expect(a.tree).toBe(b.tree);
    expect(
      (await service.listCheckpoints({ repo, threadId: "concurrent" })).map((entry) => entry.id),
    ).toEqual(
      [a, b].toSorted((left, right) => left.sequence - right.sequence).map((entry) => entry.id),
    );
    expect(await scalar(repo, "rev-parse", a.id)).toBe(a.sha);
    expect(await scalar(repo, "rev-parse", b.id)).toBe(b.sha);
  });

  test("thread deletion removes only that thread's refs and permits later checkpoints", async () => {
    const repo = await repository();
    await service.createCheckpoint({ worktree: repo, threadId: "one", label: "one" });
    const keep = await service.createCheckpoint({
      worktree: repo,
      threadId: "one-other",
      label: "keep",
    });
    expect(await service.deleteCheckpoints({ repo, threadId: "one" })).toEqual({ deleted: 1 });
    expect(await service.listCheckpoints({ repo, threadId: "one" })).toEqual([]);
    expect(await service.listCheckpoints({ repo, threadId: "one-other" })).toEqual([keep]);
    expect(await service.deleteCheckpoints({ repo, threadId: "one" })).toEqual({ deleted: 0 });
    const next = await service.createCheckpoint({ worktree: repo, threadId: "one", label: "new" });
    expect(await service.listCheckpoints({ repo, threadId: "one" })).toEqual([next]);
  });

  test("an unborn repository checkpoints without creating HEAD or an index", async () => {
    const repo = await scratch();
    await git(repo, "init", "-b", "main");
    await put(repo, "initial.txt", "initial\n");
    const checkpoint = await service.createCheckpoint({
      worktree: repo,
      threadId: "unborn",
      label: "before first commit",
    });
    expect((await git(repo, "show", `${checkpoint.sha}:initial.txt`)).toString()).toBe("initial\n");
    expect(await service.repositoryInfo(repo)).toMatchObject({ head: null, branch: "main" });
    await expect(readFile(join(repo, ".git", "index"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("5,000 files checkpoint through Git without reading working files in JavaScript", async () => {
    const repo = await repository({});
    for (let batch = 0; batch < 50; batch++) {
      await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          put(repo, `files/${batch * 100 + i}.txt`, `file ${batch * 100 + i}\n`),
        ),
      );
    }
    await git(repo, "add", "--all");
    const expectedTree = await scalar(repo, "write-tree");
    const entry = pathToFileURL(fileURLToPath(new URL("./index.ts", import.meta.url))).href;
    // A separate Node process guards filesystem reads at the boundary. It still runs real
    // Git subprocesses, and real fs operations for metadata and temporary-index cleanup.
    const script = `
      import fs from 'node:fs';
      import promises from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      const repo = ${JSON.stringify(repo)};
      const guard = (original) => function(path, ...args) {
        if (typeof path === 'string' && path.startsWith(repo + '/')) throw new Error('JS read of worktree: ' + path);
        return original.call(this, path, ...args);
      };
      for (const key of ['readFile', 'readFileSync', 'open', 'openSync', 'createReadStream']) fs[key] = guard(fs[key]);
      for (const key of ['readFile', 'open']) promises[key] = guard(promises[key]);
      syncBuiltinESMExports();
      const { GitService } = await import(${JSON.stringify(entry)});
      const checkpoint = await new GitService().createCheckpoint({worktree: repo, threadId: 'large', label: 'large'});
      process.stdout.write(JSON.stringify(checkpoint));
    `;
    const output = await execute(process.execPath, ["--input-type=module", "--eval", script], {
      timeout: 120_000,
    });
    const checkpoint = z
      .object({ tree: z.string(), sha: z.string() })
      .parse(JSON.parse(output.stdout));
    expect(checkpoint.tree).toBe(expectedTree);
    expect(
      (await git(repo, "ls-tree", "-r", "--name-only", "-z", checkpoint.sha))
        .toString()
        .split("\0")
        .filter(Boolean),
    ).toHaveLength(5_000);
  }, 120_000);
});

describe("restore", () => {
  test("restore round-trips modifications, deletions, additions and renames with a safety checkpoint", async () => {
    const repo = await repository({
      ".gitignore": "ignored/\n",
      "modify 雪.txt": "original\n",
      "delete\nfile.txt": "keep\n",
      "rename me.txt": "move\n",
    });
    await put(repo, "untracked\n雪.txt", "capture\n");
    const checkpoint = await service.createCheckpoint({
      worktree: repo,
      threadId: "restore",
      label: "before",
    });
    await put(repo, "modify 雪.txt", "changed\n");
    await rm(join(repo, "delete\nfile.txt"));
    await rename(join(repo, "rename me.txt"), join(repo, "renamed.txt"));
    await put(repo, "new\n雪.txt", "remove\n");
    await put(repo, "ignored/private.txt", "leave alone\n");
    await git(repo, "add", "--all");
    const index = await readFile(join(repo, ".git", "index"));
    const head = await scalar(repo, "rev-parse", "HEAD");
    const beforeRestore = await service.createCheckpoint({
      worktree: repo,
      threadId: "restore",
      label: "changed",
    });
    const result = await service.restoreCheckpoint({ worktree: repo, checkpoint: checkpoint.id });
    const restored = await service.createCheckpoint({
      worktree: repo,
      threadId: "restore",
      label: "after",
    });
    expect(restored.tree).toBe(checkpoint.tree);
    expect(await scalar(repo, "rev-parse", "HEAD")).toBe(head);
    expect(await scalar(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
    expect(await readFile(join(repo, ".git", "index"))).toEqual(index);
    expect(await readFile(join(repo, "ignored/private.txt"), "utf8")).toBe("leave alone\n");
    const safety = (await service.listCheckpoints({ repo, threadId: "restore" })).find(
      (entry) => entry.id === result.safetyCheckpointId,
    );
    expect(safety?.tree).toBe(beforeRestore.tree);
    // The returned safety id can undo the restore, including all added files.
    await service.restoreCheckpoint({ worktree: repo, checkpoint: result.safetyCheckpointId });
    const undone = await service.createCheckpoint({
      worktree: repo,
      threadId: "restore",
      label: "undo",
    });
    expect(undone.tree).toBe(beforeRestore.tree);
  });

  test("ignored file collisions refuse restore and return the safety checkpoint in the error", async () => {
    const repo = await repository({ ".gitignore": "private/\n", private: "old file\n" });
    const target = await service.createCheckpoint({
      worktree: repo,
      threadId: "collision",
      label: "target",
    });
    await rm(join(repo, "private"));
    await git(repo, "rm", "--cached", "private");
    await git(repo, "commit", "-m", "Remove private");
    await put(repo, "private/secret", "do not delete\n");
    await expect(
      service.restoreCheckpoint({ worktree: repo, checkpoint: target.id }),
    ).rejects.toMatchObject({
      code: "restore_collision",
      details: { safetyCheckpointId: "refs/ace/checkpoints/collision/2" },
    });
    expect(await readFile(join(repo, "private/secret"), "utf8")).toBe("do not delete\n");
    expect(await service.listCheckpoints({ repo, threadId: "collision" })).toHaveLength(2);
  });

  test("restoring over a symlink directory does not modify its external target", async () => {
    const repo = await repository({ "dir/file.txt": "inside\n" });
    const checkpoint = await service.createCheckpoint({
      worktree: repo,
      threadId: "symlink",
      label: "directory",
    });
    const outside = await scratch();
    await put(outside, "file.txt", "outside\n");
    await rm(join(repo, "dir"), { recursive: true });
    await symlink(outside, join(repo, "dir"));
    await service.restoreCheckpoint({ worktree: repo, checkpoint: checkpoint.id });
    expect(await readFile(join(outside, "file.txt"), "utf8")).toBe("outside\n");
    expect(await readFile(join(repo, "dir/file.txt"), "utf8")).toBe("inside\n");
  });
});
