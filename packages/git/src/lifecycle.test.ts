import { PROCESS_TEST_TIMEOUT } from "@ace/provider-kit/testing";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { execute, git, proxyGit, repository, scalar, scratch } from "./test-repo.ts";

test("same-worktree operations wait for the earlier operation across service instances", async () => {
  const repo = await repository();
  const entry = pathToFileURL(fileURLToPath(new URL("./index.ts", import.meta.url))).href;
  // The first operation pauses at its injected clock. beforeExit is a positive
  // event-loop-idle barrier: all of the second operation's real I/O has drained.
  // Without the predecessor wait, the second operation commits before this barrier.
  const script = `
    const { GitService } = await import(${JSON.stringify(entry)});
    const reached = Promise.withResolvers();
    const gate = Promise.withResolvers();
    let calls = 0;
    const now = () => {
      if (++calls === 1) { reached.resolve(); return gate.promise; }
      return new Date('2025-01-02T03:04:05.006Z');
    };
    process.on('beforeExit', () => gate.resolve(new Date('2025-01-02T03:04:05.006Z')));
    const first = new GitService({now}).createCheckpoint({worktree: ${JSON.stringify(repo)}, threadId:'ordered', label:'first'});
    await reached.promise;
    const second = new GitService({now}).createCheckpoint({worktree: ${JSON.stringify(join(repo, ".git", ".."))}, threadId:'ordered', label:'second'});
    const checkpoints = await Promise.all([first, second]);
    process.stdout.write(JSON.stringify(checkpoints.map(checkpoint => [checkpoint.label, checkpoint.sequence])));
  `;
  const output = await execute(process.execPath, ["--input-type=module", "--eval", script], {
    timeout: PROCESS_TEST_TIMEOUT,
  });
  expect(JSON.parse(output.stdout)).toEqual([
    ["first", 1],
    ["second", 2],
  ]);
  expect(
    (await new GitService().listCheckpoints({ repo, threadId: "ordered" })).map(
      (checkpoint) => checkpoint.label,
    ),
  ).toEqual(["first", "second"]);
});

test("temporary index directories are removed after success and after Git failure", async () => {
  const repo = await repository();
  const temporary = await scratch();
  const index = await readFile(join(repo, ".git", "index"));
  await new GitService({ tempDirectory: temporary }).createCheckpoint({
    worktree: repo,
    threadId: "cleanup",
    label: "success",
  });
  expect(await readdir(temporary)).toEqual([]);
  const observed = join(await scratch(), "index-existed");
  const binary = await proxyGit(`if (args.includes('write-tree')) {
    fs.writeFileSync(${JSON.stringify(observed)}, String(fs.existsSync(process.env.GIT_INDEX_FILE)));
    process.stderr.write('intentional write-tree failure'); process.exit(23);
  }`);
  await expect(
    new GitService({ gitBinary: binary, tempDirectory: temporary }).createCheckpoint({
      worktree: repo,
      threadId: "cleanup",
      label: "failure",
    }),
  ).rejects.toMatchObject({ code: "git_failed" });
  expect(await readFile(observed, "utf8")).toBe("true");
  expect(await readdir(temporary)).toEqual([]);
  expect(await readFile(join(repo, ".git", "index"))).toEqual(index);
});

test("checkpoint metadata and commit dates use the injected clock", async () => {
  const repo = await repository();
  const service = new GitService({ now: () => new Date("2025-01-02T03:04:05.006Z") });
  const checkpoint = await service.createCheckpoint({
    worktree: repo,
    threadId: "clock",
    label: "fixed time",
  });
  expect(checkpoint.createdAt).toBe("2025-01-02T03:04:05.006Z");
  expect(await service.listCheckpoints({ repo, threadId: "clock" })).toEqual([checkpoint]);
  expect(await scalar(repo, "show", "-s", "--format=%at", checkpoint.sha)).toBe("1735787045");
});

test("missing working directories are not reported as missing Git binaries", async () => {
  const repo = await repository();
  const binary = await proxyGit(`if (args.includes('worktree') && args.includes('list')) {
    const result = spawnSync('git', args);
    process.stdout.write(result.stdout);
    fs.rmSync(${JSON.stringify(repo)}, {recursive:true, force:true});
    process.exit(result.status ?? 72);
  }`);
  await expect(new GitService({ gitBinary: binary }).status(repo)).rejects.toMatchObject({
    code: "not_a_repo",
  });
});

test("sparse checkout refuses snapshots before changing the index or checkpoint refs", async () => {
  const repo = await repository({
    "included/file.txt": "included\n",
    "excluded/file.txt": "excluded\n",
  });
  await git(repo, "sparse-checkout", "init", "--cone");
  await git(repo, "sparse-checkout", "set", "included");
  await expect(readFile(join(repo, "excluded/file.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  const index = await readFile(join(repo, ".git", "index"));
  const service = new GitService();
  await expect(
    service.createCheckpoint({ worktree: repo, threadId: "sparse", label: "unsupported" }),
  ).rejects.toMatchObject({ code: "unsupported_repository" });
  expect(await readFile(join(repo, ".git", "index"))).toEqual(index);
  expect(await service.listCheckpoints({ repo, threadId: "sparse" })).toEqual([]);
});
