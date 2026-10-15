import { expect, test } from "vitest";
import { GitService, spawnGitProcess } from "./index.ts";
import { git, put, proxyGit, repository } from "./test-repo.ts";

test("checkpoint staging can finish beyond the ordinary Git deadline without changing the user's index", async () => {
  const repo = await repository();
  await put(repo, "tracked.txt", "new checkpoint contents\n");
  const before = await git(repo, "diff", "--cached");
  const binary = await proxyGit(`
    if(args.includes('--pathspec-from-file=-'))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
  `);
  let staging = false;
  const service = new GitService({
    gitBinary: binary,
    processRuntime: {
      spawn(command, args, options) {
        staging = args.includes("--pathspec-from-file=-");
        return spawnGitProcess(command, args, options);
      },
      scheduleTimeout(callback, milliseconds) {
        // Accelerate only the slow staging process: 30 s becomes 30 ms, 10 min becomes 600 ms.
        const timer = setTimeout(callback, staging ? milliseconds / 1000 : 10_000);
        return () => clearTimeout(timer);
      },
    },
  });
  try {
    const checkpoint = await service.createCheckpoint({
      worktree: repo,
      threadId: "turn",
      label: "Before turn",
    });
    expect((await git(repo, "show", `${checkpoint.sha}:tracked.txt`)).toString()).toBe(
      "new checkpoint contents\n",
    );
    expect(await git(repo, "diff", "--cached")).toEqual(before);
  } finally {
    await service.close();
  }
});
