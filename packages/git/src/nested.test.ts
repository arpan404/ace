import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, put, repository, scalar, userState } from "./test-repo.ts";

const service = new GitService();

test.each(["embedded", "submodule"])(
  "checkpoints capture and restore dirty %s contents without altering either repository metadata",
  async (kind) => {
    const source = await repository({
      "tracked.txt": "original\n",
      "deleted.txt": "restore me\n",
      ".gitignore": "ignored/\n",
    });
    const repo = await repository();
    const path = "nested space 雪";
    const nested = join(repo, path);
    if (kind === "submodule")
      await git(repo, "-c", "protocol.file.allow=always", "submodule", "add", source, path);
    else await git(repo, "clone", "--", source, nested);
    await git(nested, "config", "user.name", "Test");
    await git(nested, "config", "user.email", "test@example.invalid");
    await git(nested, "config", "commit.gpgsign", "false");
    await git(repo, "add", "--all");
    await git(repo, "commit", "-m", "Nested repository");
    for (const root of [repo, nested]) {
      await put(root, "tracked.txt", "stash\n");
      await git(root, "stash", "push", "-m", "Retain stash");
    }
    await put(nested, "tracked.txt", "dirty captured\n");
    await put(nested, "untracked\n☃.txt", "capture untracked\n");
    await put(nested, "ignored/private.txt", "keep ignored\n");
    const rootState = await userState(repo);
    // --git-path covers submodules whose index/HEAD live outside their working root.
    const metadata = async () => ({
      index: await readFile(
        await scalar(nested, "rev-parse", "--path-format=absolute", "--git-path", "index"),
      ),
      head: await scalar(nested, "rev-parse", "HEAD"),
      branch: await scalar(nested, "symbolic-ref", "HEAD"),
      stash: await git(nested, "show", "--format=raw", "refs/stash"),
    });
    const nestedState = await metadata();
    const saved = await service.createCheckpoint({
      worktree: repo,
      threadId: "nested",
      label: "before",
    });
    expect((await git(repo, "show", `${saved.sha}:${path}/tracked.txt`)).toString()).toBe(
      "dirty captured\n",
    );
    expect((await git(repo, "show", `${saved.sha}:${path}/untracked\n☃.txt`)).toString()).toBe(
      "capture untracked\n",
    );
    await expect(
      git(repo, "show", `${saved.sha}:${path}/ignored/private.txt`),
    ).rejects.toBeDefined();
    expect(await userState(repo)).toEqual(rootState);
    expect(await metadata()).toEqual(nestedState);
    await put(nested, "tracked.txt", "after\n");
    await rm(join(nested, "deleted.txt"));
    await put(nested, "added.txt", "remove later\n");
    const safetyTree = (
      await service.createCheckpoint({ worktree: repo, threadId: "nested", label: "changed" })
    ).tree;
    const restored = await service.restoreCheckpoint({ worktree: repo, checkpoint: saved.id });
    expect(
      (await service.createCheckpoint({ worktree: repo, threadId: "nested", label: "restored" }))
        .tree,
    ).toBe(saved.tree);
    expect(await readFile(join(nested, "ignored/private.txt"), "utf8")).toBe("keep ignored\n");
    expect(await userState(repo)).toEqual(rootState);
    expect(await metadata()).toEqual(nestedState);
    await service.restoreCheckpoint({ worktree: repo, checkpoint: restored.safetyCheckpointId });
    expect(
      (await service.createCheckpoint({ worktree: repo, threadId: "nested", label: "undo" })).tree,
    ).toBe(safetyTree);
  },
);

test("an unborn embedded repository captures untracked files without creating its HEAD or index", async () => {
  const repo = await repository();
  const nested = join(repo, "unborn");
  await put(nested, "file.txt", "untracked\n");
  await git(nested, "init", "-b", "main");
  const saved = await service.createCheckpoint({
    worktree: repo,
    threadId: "unborn-nested",
    label: "before",
  });
  expect((await git(repo, "show", `${saved.sha}:unborn/file.txt`)).toString()).toBe("untracked\n");
  await expect(git(nested, "rev-parse", "--verify", "HEAD")).rejects.toBeDefined();
  await expect(readFile(join(nested, ".git", "index"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("uninitialized gitlinks capture current ordinary files and preserve ignored files during restore", async () => {
  const source = await repository();
  const repo = await repository({ ".gitignore": "nested/ignored.txt\n" });
  await git(repo, "-c", "protocol.file.allow=always", "submodule", "add", source, "nested");
  await git(repo, "commit", "-am", "Submodule");
  await git(repo, "submodule", "deinit", "--force", "nested");
  await put(repo, "nested/ordinary.txt", "current contents\n");
  await put(repo, "nested/ignored.txt", "ignored contents\n");
  const saved = await service.createCheckpoint({
    worktree: repo,
    threadId: "uninitialized",
    label: "capture",
  });
  expect((await git(repo, "show", `${saved.sha}:nested/ordinary.txt`)).toString()).toBe(
    "current contents\n",
  );
  await put(repo, "nested/ordinary.txt", "changed\n");
  await service.restoreCheckpoint({ worktree: repo, checkpoint: saved.id });
  expect(await readFile(join(repo, "nested/ordinary.txt"), "utf8")).toBe("current contents\n");
  expect(await readFile(join(repo, "nested/ignored.txt"), "utf8")).toBe("ignored contents\n");
});

test("nested local filters restore the same working contents without changing either index", async () => {
  const repo = await repository();
  const nested = join(repo, "child");
  await put(nested, "file.txt", "working contents\n");
  await git(nested, "init", "-b", "main");
  await git(nested, "config", "filter.case.clean", "tr a-z A-Z");
  await git(nested, "config", "filter.case.smudge", "tr A-Z a-z");
  await put(nested, ".gitattributes", "file.txt filter=case\n");
  const saved = await service.createCheckpoint({
    worktree: repo,
    threadId: "filter",
    label: "before",
  });
  expect((await git(repo, "show", `${saved.sha}:child/file.txt`)).toString()).toBe(
    "WORKING CONTENTS\n",
  );
  await put(nested, "file.txt", "later contents\n");
  await service.restoreCheckpoint({ worktree: repo, checkpoint: saved.id });
  expect(await readFile(join(nested, "file.txt"), "utf8")).toBe("working contents\n");
  await expect(readFile(join(nested, ".git", "index"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("restore refuses collisions with nested ignored files and keeps a recoverable safety checkpoint", async () => {
  const repo = await repository();
  const nested = await repository({ "file.txt": "original\n" });
  await git(repo, "clone", "--", nested, join(repo, "child"));
  const saved = await service.createCheckpoint({
    worktree: repo,
    threadId: "collision",
    label: "before",
  });
  await git(join(repo, "child"), "rm", "--cached", "file.txt");
  await put(repo, "child/.gitignore", "file.txt\n");
  await put(repo, "child/file.txt", "private ignored contents\n");
  await expect(
    service.restoreCheckpoint({ worktree: repo, checkpoint: saved.id }),
  ).rejects.toMatchObject({
    code: "restore_collision",
    details: { safetyCheckpointId: expect.any(String) },
  });
  expect(await readFile(join(repo, "child/file.txt"), "utf8")).toBe("private ignored contents\n");
  expect(
    (await service.listCheckpoints({ repo, threadId: "collision" })).map((c) => c.label),
  ).toEqual(["before", `Before restore of ${saved.id}`]);
});

test("restore protects ignored files inside an uninitialized gitlink", async () => {
  const source = await repository();
  const repo = await repository();
  await git(repo, "-c", "protocol.file.allow=always", "submodule", "add", source, "child");
  await git(repo, "commit", "-am", "Submodule");
  await git(repo, "submodule", "deinit", "--force", "child");
  await put(repo, "child/file.txt", "captured\n");
  const saved = await service.createCheckpoint({
    worktree: repo,
    threadId: "uninitialized-collision",
    label: "before",
  });
  await put(repo, ".gitignore", "child/file.txt\n");
  await put(repo, "child/file.txt", "private ignored contents\n");
  await expect(
    service.restoreCheckpoint({ worktree: repo, checkpoint: saved.id }),
  ).rejects.toMatchObject({
    code: "restore_collision",
    details: { safetyCheckpointId: expect.any(String) },
  });
  expect(await readFile(join(repo, "child/file.txt"), "utf8")).toBe("private ignored contents\n");
});

test.each(["none", "assume-unchanged", "skip-worktree"])(
  "restore refuses replacing a nested repository with a file and preserves its administrative data under %s",
  async (flag) => {
    const repo = await repository({ child: "original file\n" });
    const saved = await service.createCheckpoint({
      worktree: repo,
      threadId: "nested-root",
      label: "file",
    });
    await rm(join(repo, "child"));
    const source = await repository();
    await git(repo, "clone", "--", source, join(repo, "child"));
    await put(repo, "child/tracked.txt", "stashed\n");
    await git(
      join(repo, "child"),
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "stash",
      "push",
    );
    if (flag !== "none") await git(repo, "update-index", `--${flag}`, "child");
    const index = await readFile(join(repo, ".git", "index"));
    const head = await scalar(repo, "rev-parse", "HEAD");
    const before = await userState(join(repo, "child"));
    await expect(
      service.restoreCheckpoint({ worktree: repo, checkpoint: saved.id }),
    ).rejects.toMatchObject({
      code: "restore_collision",
      details: { safetyCheckpointId: expect.any(String) },
    });
    expect(await userState(join(repo, "child"))).toEqual(before);
    expect(await readFile(join(repo, ".git", "index"))).toEqual(index);
    expect(await scalar(repo, "rev-parse", "HEAD")).toBe(head);
    expect(await readFile(join(repo, "child", "tracked.txt"), "utf8")).toBe("original\n");
  },
);
