import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { GitService } from "@ace/git";
import { ThreadId } from "@ace/protocol";
import { compare, execute, mergeWinner, type Executor } from "./index.ts";
import { artifact, check, complete, fact, setup } from "./test-support.ts";
const exec = promisify(execFile);
async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "ace-orch-"));
  const cli = async (...args: string[]) => (await exec("git", ["-C", dir, ...args])).stdout.trim();
  await cli("init", "-b", "main");
  await cli("config", "user.name", "Test");
  await cli("config", "user.email", "test@example.invalid");
  await writeFile(join(dir, "feature.txt"), "original\n");
  await cli("add", ".");
  await cli("commit", "-m", "base");
  return { dir, cli, git: new GitService(), base: await cli("rev-parse", "HEAD") };
}
// Real subprocess I/O gets a generous runner timeout under shared CI load.
// Behaviour assertions use injected time, never measured elapsed time.
it("compares real lane checkpoints and applies the picked winner with a safety checkpoint", async () => {
  const p = await repo();
  try {
    const r = setup("fanout", 2);
    r.state.input.baseRef = p.base;
    const [a, b] = r.lanes;
    if (!a || !b) throw new Error("Missing lanes");
    for (const [n, lane] of r.lanes.entries()) {
      const path = join(p.dir, `lane-${n}`);
      await p.git.createWorktree({ repo: p.dir, path, baseRef: p.base, branch: `lane-${n}` });
      // Registered worktrees live beneath the test repo; exclude them from the target's untracked files.
      await writeFile(join(p.dir, ".git", "info", "exclude"), "lane-*\n");
      r.send({
        type: "bound",
        ...fact(lane),
        threadId: ThreadId.parse(`thread-${n}`),
        worktree: path,
      });
      await writeFile(
        join(path, "feature.txt"),
        n === 0 ? "winner\nsecond line\n" : "alternative\n",
      );
      const cp = await p.git.createCheckpoint({
        worktree: path,
        threadId: `thread-${n}`,
        label: "Result",
      });
      r.ctx.now += 20;
      r.send({ type: "usage", ...fact(lane), usage: { tokens: 50 + n, cost: 0.1 } });
      complete(r.state, lane, r.ctx, { ...artifact, checkpoint: cp.id });
      check(r.state, lane, r.ctx);
    }
    const comparisons = await compare(r.state, p.git);
    expect(
      comparisons.map((c) =>
        c.files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
      ),
    ).toEqual([
      [{ path: "feature.txt", additions: 2, deletions: 1 }],
      [{ path: "feature.txt", additions: 1, deletions: 1 }],
    ]);
    expect(comparisons[0]?.patch).toContain("+winner");
    expect(comparisons[1]?.patch).toContain("+alternative");
    expect(comparisons[0]?.usage.tokens).toBe(50);
    expect(comparisons[0]?.durationMs).toBe(20);
    expect(comparisons[0]?.artifact.tests).toEqual(artifact.tests);
    const pending = r.send({ type: "pick", laneId: a.id, merge: true }).intents[0];
    if (!pending) throw new Error("Missing merge");
    expect(r.state.status).toBe("running");
    const indexBefore = await readFile(join(p.dir, ".git", "index"));
    const executor: Executor = {
      async start() {
        throw new Error("Unexpected start");
      },
      async check() {
        throw new Error("Unexpected check");
      },
      async cancel() {
        throw new Error("Unexpected cancel");
      },
      async merge() {
        return mergeWinner(r.state, p.dir, p.git);
      },
    };
    for (const f of await execute(r.state, pending, executor)) r.send(f);
    expect(await readFile(join(p.dir, "feature.txt"), "utf8")).toBe("winner\nsecond line\n");
    expect(await p.cli("rev-parse", "HEAD")).toBe(p.base);
    expect(await readFile(join(p.dir, ".git", "index"))).toEqual(indexBefore);
    expect(r.state.status).toBe("succeeded");
    expect(r.state.mergeStatus).toBe("applied");
    if (!r.state.safetyCheckpoint) throw new Error("Missing recovery checkpoint");
    await p.git.restoreCheckpoint({ worktree: p.dir, checkpoint: r.state.safetyCheckpoint });
    expect(await readFile(join(p.dir, "feature.txt"), "utf8")).toBe("original\n");
  } finally {
    await rm(p.dir, { recursive: true, force: true });
  }
}, 60_000);
it("winner application refuses a dirty target, an advanced base and the wrong branch", async () => {
  const p = await repo();
  try {
    const r = setup("fanout", 1);
    r.state.input.baseRef = p.base;
    const a = r.lanes[0];
    if (!a) throw new Error("Missing lane");
    const cp = await p.git.createCheckpoint({
      worktree: p.dir,
      threadId: "winner",
      label: "Result",
    });
    complete(r.state, a, r.ctx, { ...artifact, checkpoint: cp.id });
    check(r.state, a, r.ctx);
    r.send({ type: "pick", laneId: a.id, merge: true });
    await writeFile(join(p.dir, "local.txt"), "keep me");
    await expect(mergeWinner(r.state, p.dir, p.git)).rejects.toThrow("target_dirty");
    expect(await readFile(join(p.dir, "local.txt"), "utf8")).toBe("keep me");
    await p.cli("add", ".");
    await p.cli("commit", "-m", "advanced");
    await expect(mergeWinner(r.state, p.dir, p.git)).rejects.toThrow("target_changed");
    r.state.input.baseRef = await p.cli("rev-parse", "HEAD");
    await p.cli("switch", "-c", "other");
    await expect(mergeWinner(r.state, p.dir, p.git)).rejects.toThrow("target_changed");
  } finally {
    await rm(p.dir, { recursive: true, force: true });
  }
}, 60_000);
it("picking a winner cancels remaining work and delays merge until stop acknowledgements", () => {
  const r = setup("fanout", 2);
  const [a, b] = r.lanes;
  if (!a || !b) throw new Error("Missing lanes");
  expect(r.send({ type: "pick", laneId: a.id, merge: true }).events[0]).toMatchObject({
    reason: "winner_not_available",
  });
  complete(r.state, a, r.ctx);
  check(r.state, a, r.ctx);
  const selected = r.send({ type: "pick", laneId: a.id, merge: true });
  expect(selected.intents.map((i) => i.effect.type)).toEqual(["cancel"]);
  expect(r.state.status).toBe("cancelling");
  const stopped = r.send({ type: "stopped", ...fact(b) });
  expect(stopped.intents.map((i) => i.effect)).toEqual([
    { type: "merge", ...fact(a), checkpoint: artifact.checkpoint },
  ]);
});
