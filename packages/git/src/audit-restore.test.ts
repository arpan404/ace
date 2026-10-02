import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { execute, git, put, repository, scalar } from "./test-repo.ts";

const service = new GitService();

test("a child checkpoint waits from parent safety capture until the whole restore finishes", async () => {
  const repo = await repository();
  const child = join(repo, "child");
  await put(child, "a.txt", "target a\n");
  await put(child, "z.txt", "target z\n");
  await git(child, "init", "-b", "main");
  const target = await service.createCheckpoint({
    worktree: repo,
    threadId: "locks",
    label: "target",
  });
  await put(child, "a.txt", "after a\n");
  await put(child, "z.txt", "after z\n");
  const entry = pathToFileURL(fileURLToPath(new URL("./index.ts", import.meta.url))).href;
  // One clock call transfers the nested safety tree. The next pauses before the
  // safety ref is written. With no live subprocesses, beforeExit proves the
  // competing checkpoint's I/O has drained or is waiting for the restore lock.
  const script = `
    const { GitService } = await import(${JSON.stringify(entry)});
    const reached = Promise.withResolvers();
    const gate = Promise.withResolvers();
    let calls = 0;
    const now = () => ++calls === 2 ? (reached.resolve(), gate.promise) : new Date('2025-01-02T03:04:05.006Z');
    process.once('beforeExit', () => gate.resolve(new Date('2025-01-02T03:04:05.006Z')));
    const restore = new GitService({now}).restoreCheckpoint({worktree:${JSON.stringify(repo)},checkpoint:${JSON.stringify(target.id)}});
    await reached.promise;
    const child = new GitService().createCheckpoint({worktree:${JSON.stringify(child)},threadId:'child',label:'during restore'});
    await restore;
    process.stdout.write(JSON.stringify(await child));
  `;
  const output = await execute(process.execPath, ["--input-type=module", "--eval", script], {
    timeout: 30_000,
  });
  const checkpoints = await service.listCheckpoints({ repo: child, threadId: "child" });
  expect(checkpoints).toHaveLength(1);
  expect(JSON.parse(output.stdout)).toEqual(checkpoints[0]);
  const checkpoint = checkpoints[0];
  if (!checkpoint) throw new Error("Missing child checkpoint");
  expect((await git(child, "show", `${checkpoint.sha}:a.txt`)).toString()).toBe("target a\n");
  expect((await git(child, "show", `${checkpoint.sha}:z.txt`)).toString()).toBe("target z\n");
});

test("nested restore uses child filters despite an incompatible required parent filter and preserves indexes", async () => {
  const repo = await repository();
  const child = join(repo, "child");
  await put(child, "file.txt", "working contents\n");
  await put(child, "deleted.txt", "restore me\n");
  await put(child, ".gitattributes", "file.txt filter=case\n");
  await git(child, "init", "-b", "main");
  await git(child, "config", "filter.case.clean", "tr a-z A-Z");
  await git(child, "config", "filter.case.smudge", "tr A-Z a-z");
  await git(child, "add", "--all");
  await git(repo, "config", "filter.case.smudge", "false");
  await git(repo, "config", "filter.case.required", "true");
  const indexes = await Promise.all(
    [repo, child].map((root) => readFile(join(root, ".git", "index"))),
  );
  const target = await service.createCheckpoint({
    worktree: repo,
    threadId: "filters",
    label: "target",
  });
  await put(child, "file.txt", "later contents\n");
  await rm(join(child, "deleted.txt"));
  await put(child, "added.txt", "remove me\n");
  const restored = await service.restoreCheckpoint({ worktree: repo, checkpoint: target.id });
  expect(await readFile(join(child, "file.txt"), "utf8")).toBe("working contents\n");
  expect(await readFile(join(child, "deleted.txt"), "utf8")).toBe("restore me\n");
  await expect(readFile(join(child, "added.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    await Promise.all([repo, child].map((root) => readFile(join(root, ".git", "index")))),
  ).toEqual(indexes);
  await service.restoreCheckpoint({ worktree: repo, checkpoint: restored.safetyCheckpointId });
  expect(await readFile(join(child, "file.txt"), "utf8")).toBe("later contents\n");
  expect(await readFile(join(child, "added.txt"), "utf8")).toBe("remove me\n");
  await expect(readFile(join(child, "deleted.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("embedded repositories under unchanged parent-tracked paths apply their own clean filters", async () => {
  const repo = await repository({
    "child/file.txt": "working contents\n",
    "child/.gitattributes": "file.txt filter=case\n",
  });
  const child = join(repo, "child");
  await git(child, "init", "-b", "main");
  await git(child, "config", "filter.case.clean", "tr a-z A-Z");
  await git(child, "add", "--all");
  const indexes = await Promise.all(
    [repo, child].map((root) => readFile(join(root, ".git", "index"))),
  );
  const saved = await service.createCheckpoint({
    worktree: repo,
    threadId: "unchanged-child",
    label: "filtered",
  });
  expect(await scalar(repo, "show", `${saved.sha}:child/file.txt`)).toBe("WORKING CONTENTS");
  expect(
    await Promise.all([repo, child].map((root) => readFile(join(root, ".git", "index")))),
  ).toEqual(indexes);
  await rm(join(child, "file.txt"));
  const removed = await service.createCheckpoint({
    worktree: repo,
    threadId: "unchanged-child",
    label: "deleted child file",
  });
  await expect(git(repo, "show", `${removed.sha}:child/file.txt`)).rejects.toBeDefined();
});

test("restoring a checkpoint without a child subtree removes its captured files but preserves its repository and ignored files", async () => {
  const repo = await repository();
  const target = await service.createCheckpoint({
    worktree: repo,
    threadId: "absent",
    label: "before child",
  });
  const child = join(repo, "child");
  await put(child, "file.txt", "remove me\n");
  await put(child, ".gitignore", "private.txt\n");
  await git(child, "init", "-b", "main");
  await git(child, "add", "--all");
  await put(child, "private.txt", "keep me\n");
  const index = await readFile(join(child, ".git", "index"));
  const restored = await service.restoreCheckpoint({ worktree: repo, checkpoint: target.id });
  await expect(readFile(join(child, "file.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(child, "private.txt"), "utf8")).toBe("keep me\n");
  expect(await readFile(join(child, ".git", "index"))).toEqual(index);
  await service.restoreCheckpoint({ worktree: repo, checkpoint: restored.safetyCheckpointId });
  expect(await readFile(join(child, "file.txt"), "utf8")).toBe("remove me\n");
});
