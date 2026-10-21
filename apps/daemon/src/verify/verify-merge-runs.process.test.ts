import { expect, test } from "vitest";
import type { VerifyRun, VerifyTarget } from "@ace/protocol";
import { inRepo, verifyFixture } from "./verify-test-support.ts";

type Fixture = Awaited<ReturnType<typeof verifyFixture>>;
const allowed = () => true;

async function startedRun(f: Fixture, target: VerifyTarget) {
  const answer = await f.verify.start(f.workspaceId, target, allowed);
  if (!answer.ok) throw new Error(`start refused: ${answer.error}`);
  return answer.run;
}

const steps = (run: VerifyRun) =>
  run.steps.map((step) => `${step.kind}${step.pr ? `#${step.pr}` : ""}:${step.state}`);

test("a verified batch checks the PRs together, then merges each on GitHub in order at its tested head", async () => {
  const f = await verifyFixture();
  try {
    // Passes only on the combined tree: each PR alone lacks the other's file.
    f.setCommand("cat a.txt b.txt");
    const a = await f.pr(1, { "a.txt": "from one\n" });
    const b = await f.pr(2, { "b.txt": "from two\n" });
    const base = await inRepo(f.project, "rev-parse", "main");
    const done = await f.settled(
      (
        await startedRun(
          f,
          f.merge(
            [
              [1, a],
              [2, b],
            ],
            "rebase",
          ),
        )
      ).id,
    );
    expect(done).toMatchObject({
      state: "merged",
      merged: [1, 2],
      base: { branch: "main", sha: base },
      exitCode: 0,
    });
    expect(steps(done)).toEqual([
      "fetch:done",
      "combine#1:done",
      "combine#2:done",
      "setup:skipped",
      "check:done",
      "merge#1:done",
      "merge#2:done",
    ]);
    expect(f.forge.merges).toEqual([
      { pr: 1, headSha: a, method: "rebase" },
      { pr: 2, headSha: b, method: "rebase" },
    ]);
    expect(f.verify.log(done.id)?.text).toContain("from one\nfrom two\n");
    expect(await f.trees()).toEqual([]);
    expect(await inRepo(f.project, "for-each-ref", "refs/ace/conductor/")).toBe("");
  } finally {
    await f.close();
  }
});

test("a batch stops at the first conflict, naming the PR before it, and merges nothing", async () => {
  const f = await verifyFixture();
  try {
    f.setCommand("echo should-not-run");
    const a = await f.pr(1, { "file.txt": "one\n" });
    const b = await f.pr(2, { "file.txt": "two\n" });
    const done = await f.settled(
      (
        await startedRun(
          f,
          f.merge([
            [1, a],
            [2, b],
          ]),
        )
      ).id,
    );
    expect(done).toMatchObject({
      state: "stopped",
      failure: { code: "conflict", pr: 2, with: 1, message: "#2 conflicts with #1" },
      merged: [],
    });
    expect(steps(done)).toEqual([
      "fetch:done",
      "combine#1:done",
      "combine#2:failed",
      "setup:skipped",
      "check:skipped",
      "merge#1:skipped",
      "merge#2:skipped",
    ]);
    expect(f.forge.merges).toEqual([]);
    expect(await f.trees()).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a PR whose head moved stops the batch before anything is combined", async () => {
  const f = await verifyFixture();
  try {
    f.setCommand("true");
    const a = await f.pr(1, { "a.txt": "one\n" });
    const stale = await f.pr(2, { "b.txt": "two\n" });
    await f.pr(3, { "b.txt": "two, revised\n" });
    await inRepo(f.project, "push", "-q", "-f", "origin", "pr-3:refs/pull/2/head");
    const done = await f.settled(
      (
        await startedRun(
          f,
          f.merge([
            [1, a],
            [2, stale],
          ]),
        )
      ).id,
    );
    expect(done).toMatchObject({ state: "stopped", failure: { code: "head_moved", pr: 2 } });
    expect(steps(done)[0]).toBe("fetch:failed");
    expect(f.forge.merges).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a base that moved after the check passed stops the batch before any merge", async () => {
  const f = await verifyFixture();
  try {
    const a = await f.pr(1, { "a.txt": "one\n" });
    const elsewhere = await f.pr(2, { "c.txt": "landed meanwhile\n" });
    // Someone merges to main on GitHub while the check runs.
    f.setCommand(`git --git-dir='${f.origin}' update-ref refs/heads/main ${elsewhere}`);
    const done = await f.settled((await startedRun(f, f.merge([[1, a]]))).id);
    expect(done).toMatchObject({
      state: "stopped",
      failure: { code: "base_moved" },
      merged: [],
    });
    expect(steps(done).at(-1)).toBe("merge#1:skipped");
    expect(f.forge.merges).toEqual([]);
  } finally {
    await f.close();
  }
});

test("GitHub refusing a PR mid-batch keeps the merges before it and stops", async () => {
  const f = await verifyFixture();
  try {
    f.setCommand("true");
    const heads = [
      await f.pr(1, { "a.txt": "one\n" }),
      await f.pr(2, { "b.txt": "two\n" }),
      await f.pr(3, { "c.txt": "three\n" }),
    ];
    f.forge.refuse.add(2);
    const done = await f.settled(
      (await startedRun(f, f.merge(heads.map((head, index) => [index + 1, head] as const)))).id,
    );
    expect(done).toMatchObject({
      state: "stopped",
      merged: [1],
      failure: { code: "merge_refused", pr: 2 },
    });
    expect(done.failure?.message).toContain("Required reviews are missing");
    expect(steps(done).slice(-3)).toEqual(["merge#1:done", "merge#2:failed", "merge#3:skipped"]);
    expect(f.forge.merges.map((merge) => merge.pr)).toEqual([1, 2]);
  } finally {
    await f.close();
  }
});

test("a lost GitHub answer stops the batch as merge_uncertain", async () => {
  const f = await verifyFixture();
  try {
    f.setCommand("true");
    const a = await f.pr(1, { "a.txt": "one\n" });
    const b = await f.pr(2, { "b.txt": "two\n" });
    f.forge.lose.add(1);
    const done = await f.settled(
      (
        await startedRun(
          f,
          f.merge([
            [1, a],
            [2, b],
          ]),
        )
      ).id,
    );
    expect(done).toMatchObject({
      state: "stopped",
      merged: [],
      failure: { code: "merge_uncertain", pr: 1 },
    });
    expect(f.forge.merges.map((merge) => merge.pr)).toEqual([1]);
  } finally {
    await f.close();
  }
});

test("a batch with a PR in a GitHub stack, or the same PR twice, is refused", async () => {
  const f = await verifyFixture();
  try {
    f.setCommand("true");
    const a = await f.pr(1, { "a.txt": "one\n" });
    const b = await f.pr(2, { "b.txt": "two\n" });
    f.forge.stackedPrs.add(2);
    const target = f.merge([
      [1, a],
      [2, b],
    ]);
    expect(await f.verify.start(f.workspaceId, target, allowed)).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(
      await f.verify.start(
        f.workspaceId,
        f.merge([
          [1, a],
          [1, a],
        ]),
        allowed,
      ),
    ).toEqual({ ok: false, error: "invalid" });
    expect(await f.verify.list(f.workspaceId)).toMatchObject({ runs: [] });
  } finally {
    await f.close();
  }
});

test("cancel is refused once GitHub merges began", async () => {
  const f = await verifyFixture();
  try {
    f.setCommand("true");
    const a = await f.pr(1, { "a.txt": "one\n" });
    const release = f.forge.hold(1);
    const batch = await startedRun(f, f.merge([[1, a]]));
    await f.until(batch.id, (entry) => entry.state === "merging");
    expect(await f.verify.cancel(batch.id)).toEqual({ ok: false, error: "settled" });
    release();
    expect(await f.settled(batch.id)).toMatchObject({ state: "merged", merged: [1] });
  } finally {
    await f.close();
  }
});

test("a restart while merging settles from what GitHub reports", async () => {
  const f = await verifyFixture();
  try {
    f.setCommand("true");
    const a = await f.pr(1, { "a.txt": "one\n" });
    const b = await f.pr(2, { "b.txt": "two\n" });
    const release = f.forge.hold(2);
    const batch = await startedRun(
      f,
      f.merge([
        [1, a],
        [2, b],
      ]),
    );
    await f.until(batch.id, (entry) => entry.merged.includes(1));
    // The daemon dies while #2's merge is in flight; GitHub never merged it.
    const next = f.open();
    await next.recover();
    expect(await f.verify.list(f.workspaceId)).toMatchObject({
      runs: [
        {
          id: batch.id,
          state: "stopped",
          merged: [1],
          failure: { code: "unavailable", pr: 2 },
        },
      ],
    });
    expect(f.changes.findLast((entry) => entry.id === batch.id)).toMatchObject({
      state: "stopped",
      merged: [1],
      failure: { code: "unavailable", pr: 2 },
    });
    await next.close();
    f.forge.refuse.add(2);
    release();
  } finally {
    await f.close();
  }
});
