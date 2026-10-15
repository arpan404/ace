import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { proxyGit, repository, scratch } from "./test-repo.ts";

/** A Git whose `worktree list` hangs until the gate file appears, like a stalled filesystem. */
async function stalledListing() {
  const gate = await scratch();
  const open = join(gate, "open");
  const binary =
    await proxyGit(`if (args.includes('worktree') && args.includes('list') && !fs.existsSync(${JSON.stringify(open)})) {
    const wait = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(open)})) return;
      clearInterval(wait);
      const child = spawn('git', args, { stdio: 'inherit', shell: false });
      child.on('close', code => process.exit(code ?? 71));
    }, 20);
    return;
  }`);
  return { binary, release: () => writeFile(open, "") };
}

test("an aborted signal stops a stalled worktree listing and the reads queued behind it", async () => {
  const repo = await repository();
  const stalled = await stalledListing();
  const service = new GitService({ gitBinary: stalled.binary });
  try {
    const controller = new AbortController();
    const listing = service.listWorktrees(repo, { signal: controller.signal });
    const queued = service.resolveCommit({
      worktree: repo,
      ref: "HEAD",
      signal: controller.signal,
    });
    const settled = Promise.allSettled([listing, queued]);
    const started = Date.now();
    setTimeout(() => controller.abort(), 200);
    const [first, second] = await settled;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(first.status).toBe("rejected");
    expect(second).toMatchObject({ status: "rejected", reason: { code: "git_cancelled" } });
    // Without a signal the same reads still complete once Git answers.
    await stalled.release();
    expect(await service.listWorktrees(repo)).toHaveLength(1);
    expect(await service.resolveCommit({ worktree: repo, ref: "HEAD" })).toMatch(/^[0-9a-f]{40}$/);
  } finally {
    await stalled.release();
    await service.close();
  }
});

test("a branch head read honours an already aborted signal", async () => {
  const repo = await repository();
  const service = new GitService();
  try {
    await expect(
      service.branchHead({ repo, branch: "main", signal: AbortSignal.abort() }),
    ).rejects.toBeDefined();
    expect(await service.branchHead({ repo, branch: "main" })).toMatch(/^[0-9a-f]{40}$/);
  } finally {
    await service.close();
  }
});
