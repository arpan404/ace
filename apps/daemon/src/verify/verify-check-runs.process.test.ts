import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { inRepo, verifyFixture } from "./verify-test-support.ts";

const allowed = () => true;

async function started(
  f: Awaited<ReturnType<typeof verifyFixture>>,
  target: Parameters<typeof f.verify.start>[1],
) {
  const answer = await f.verify.start(f.workspaceId, target, allowed);
  if (!answer.ok) throw new Error(`start refused: ${answer.error}`);
  return answer.run;
}

async function gone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test("a project without a check command lists none and refuses to start a run", async () => {
  const f = await verifyFixture();
  try {
    const head = await f.pr(7, { "pr.txt": "work\n" });
    expect(await f.verify.list(f.workspaceId)).toEqual({ ok: true, runs: [], command: null });
    expect(await f.verify.start(f.workspaceId, f.check(7, head), allowed)).toEqual({
      ok: false,
      error: "no_command",
    });
  } finally {
    await f.close();
  }
});

test("without a configured command, the project's check script runs with its package manager", async () => {
  const f = await verifyFixture();
  try {
    await writeFile(
      join(f.project, "package.json"),
      JSON.stringify({ scripts: { check: "echo checked" } }),
    );
    await writeFile(join(f.project, "bun.lock"), "{}\n");
    expect(await f.verify.list(f.workspaceId)).toMatchObject({ command: "bun run 'check'" });
    f.setCommand("make verify");
    expect(await f.verify.list(f.workspaceId)).toMatchObject({ command: "make verify" });
  } finally {
    await f.close();
  }
});

test("a passing check runs at the PR's head, keeps its output and removes its checkout", async () => {
  const f = await verifyFixture();
  try {
    f.setCommand("cat pr.txt && echo all good");
    const head = await f.pr(7, { "pr.txt": "only on the PR\n" });
    const queued = await started(f, f.check(7, head));
    // With nothing ahead of it, the run starts at once.
    expect(queued).toMatchObject({ state: "running", command: "cat pr.txt && echo all good" });
    const done = await f.settled(queued.id);
    expect(done).toMatchObject({ state: "passed", exitCode: 0, merged: [] });
    expect(done.failure).toBeUndefined();
    expect(done.steps.map((step) => [step.kind, step.state])).toEqual([
      ["fetch", "done"],
      ["setup", "skipped"],
      ["check", "done"],
    ]);
    expect(f.verify.log(queued.id)?.text).toContain("only on the PR\nall good\n");
    expect(await f.trees()).toEqual([]);
    expect(await inRepo(f.project, "branch", "--list", "ace-verify/*")).toBe("");
    expect(await f.verify.list(f.workspaceId)).toMatchObject({ runs: [{ id: queued.id }] });
  } finally {
    await f.close();
  }
});

test("a failing check fails with its exit code and keeps what it printed", async () => {
  const f = await verifyFixture();
  try {
    f.setCommand("echo 'type error in pr.txt' >&2; exit 3");
    const head = await f.pr(7, { "pr.txt": "broken\n" });
    const done = await f.settled((await started(f, f.check(7, head))).id);
    expect(done).toMatchObject({
      state: "failed",
      exitCode: 3,
      failure: { code: "check_failed" },
    });
    expect(done.steps.at(-1)).toMatchObject({ kind: "check", state: "failed" });
    expect(f.verify.log(done.id)?.text).toContain("type error in pr.txt");
  } finally {
    await f.close();
  }
});

test("the project's setup script runs in the checkout before the check", async () => {
  const f = await verifyFixture();
  try {
    f.setCommand("cat prepared.txt");
    const head = await f.pr(7, {
      Makefile: "setup:\n\techo prepared-by-setup > prepared.txt\n",
    });
    const done = await f.settled((await started(f, f.check(7, head))).id);
    expect(done).toMatchObject({ state: "passed" });
    expect(done.steps.find((step) => step.kind === "setup")).toMatchObject({ state: "done" });
    expect(f.verify.log(done.id)?.text).toContain("prepared-by-setup");
  } finally {
    await f.close();
  }
});

test("a PR whose head moved since it was selected fails as head_moved without running the check", async () => {
  const f = await verifyFixture();
  try {
    f.setCommand("echo should-not-run");
    const old = await f.pr(7, { "pr.txt": "first\n" });
    await f.pr(8, { "pr.txt": "second\n" });
    await inRepo(f.project, "push", "-q", "-f", "origin", "pr-8:refs/pull/7/head");
    const done = await f.settled((await started(f, f.check(7, old))).id);
    expect(done).toMatchObject({ state: "failed", failure: { code: "head_moved", pr: 7 } });
    expect(f.verify.log(done.id)?.text ?? "").not.toContain("should-not-run");
  } finally {
    await f.close();
  }
});

test("a second run of the project waits until the first settles", async () => {
  const f = await verifyFixture();
  try {
    const gate = join(f.scratch, "gate");
    f.setCommand(`while [ ! -f '${gate}' ]; do sleep 0.05; done; echo through`);
    const head = await f.pr(7, { "pr.txt": "work\n" });
    const first = await started(f, f.check(7, head));
    const second = await started(f, f.check(7, head));
    await f.until(first.id, (entry) =>
      entry.steps.some((s) => s.kind === "check" && s.state === "running"),
    );
    expect(f.changes.findLast((entry) => entry.id === second.id)?.state).toBe("queued");
    await writeFile(gate, "");
    const [a, b] = await Promise.all([f.settled(first.id), f.settled(second.id)]);
    expect([a.state, b.state]).toEqual(["passed", "passed"]);
    expect(b.startedAt ?? 0).toBeGreaterThanOrEqual(a.endedAt ?? Infinity);
  } finally {
    await f.close();
  }
});

test("cancel stops the check command's whole process group and removes the checkout", async () => {
  const f = await verifyFixture();
  try {
    const pidFile = join(f.scratch, "child.pid");
    f.setCommand(`sleep 60 & echo $! > '${pidFile}'; wait`);
    const head = await f.pr(7, { "pr.txt": "work\n" });
    const run7 = await started(f, f.check(7, head));
    await f.until(run7.id, (entry) =>
      entry.steps.some((s) => s.kind === "check" && s.state === "running"),
    );
    while (!existsSync(pidFile)) await new Promise((resolve) => setTimeout(resolve, 20));
    const child = Number((await readFile(pidFile, "utf8")).trim());
    const answer = await f.verify.cancel(run7.id);
    expect(answer).toMatchObject({ ok: true, run: { state: "cancelled" } });
    expect(await gone(child)).toBe(true);
    expect(await f.trees()).toEqual([]);
    expect(await f.verify.cancel(run7.id)).toEqual({ ok: false, error: "settled" });
  } finally {
    await f.close();
  }
});

test("a restart settles a run that was checking as interrupted and removes its checkout", async () => {
  const f = await verifyFixture();
  const gate = join(f.scratch, "gate");
  try {
    f.setCommand(`while [ ! -f '${gate}' ]; do sleep 0.05; done`);
    const head = await f.pr(7, { "pr.txt": "work\n" });
    const checking = await started(f, f.check(7, head));
    await f.until(checking.id, (entry) =>
      entry.steps.some((s) => s.kind === "check" && s.state === "running"),
    );
    expect(await f.trees()).toHaveLength(1);
    // The daemon that ran it is gone; the next one starts over the same store.
    const next = f.open();
    await next.recover();
    expect(await f.verify.list(f.workspaceId)).toMatchObject({
      runs: [{ id: checking.id, state: "interrupted" }],
    });
    expect(await f.trees()).toEqual([]);
    await next.close();
  } finally {
    await writeFile(gate, "");
    await f.close();
  }
});
