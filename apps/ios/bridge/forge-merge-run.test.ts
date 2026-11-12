import "./test-host.ts";
import { expect, test } from "vitest";
import type { MergeRunReply } from "./forge-merge-run.ts";
import type { PullsReply } from "./forge-lists.ts";
import { connected } from "./forge-test-fixture.ts";

/*
 * The verified merge of several pull requests from the phone's list, on the fake daemon: #233
 * and #224 in acme/ace are ready to merge into main, and Verify steps through a run.
 */

type Ask = (request: Record<string, unknown>) => Promise<unknown>;
const ready = async (ask: Ask) => {
  const list = (await ask({ type: "forge.pulls", project: "ace", search: {} })) as PullsReply;
  return list.groups.flatMap((group) => group.rows).filter((row) => row.mergePick);
};
const strip = async (ask: Ask, picked: Awaited<ReturnType<typeof ready>>, all = picked) =>
  (await ask({
    type: "forge.merge-run",
    project: "ace",
    picked: picked.map((row) => row.mergePick),
    rows: all.map((row) => ({
      key: row.key,
      base: row.mergePick?.base,
      headSha: row.mergePick?.headSha,
    })),
  })) as MergeRunReply;
const write = (ask: Ask, op: Record<string, unknown>) =>
  ask({ type: "forge.merge-run.write", project: "ace", op }) as Promise<{
    ok: boolean;
    message: string;
  }>;

test("only the ready pull requests can be picked, each with the head the list read", async () => {
  const { ask } = await connected();
  const rows = await ready(ask);
  expect(rows.map((row) => row.number)).toEqual([233, 224]);
  expect(rows[0]?.mergePick).toMatchObject({ number: 233, base: "main" });
  expect(rows[0]?.mergePick?.headSha).toMatch(/^[a-f0-9]{40}$/);
});

test("picking ready rows offers to verify and merge them; Start sends one run with both heads in list order", async () => {
  const { ask, daemon } = await connected();
  const verify = daemon.services.verify;
  verify.paused = true;
  const rows = await ready(ask);
  expect((await strip(ask, [])).pick).toBeNull();
  const picked = await strip(ask, rows);
  expect(picked.pick).toEqual({
    sentence: "Verify and merge 2 pull requests into main",
    start: true,
  });
  expect(picked.run).toBeNull();
  const started = await write(ask, {
    kind: "start",
    method: "squash",
    prs: rows.map((row) => row.mergePick),
  });
  expect(started.ok).toBe(true);
  expect(
    verify.started.map(({ target }) =>
      target.kind === "merge" ? target.prs.map((pr) => [pr.pr.number, pr.headSha]) : [],
    ),
  ).toEqual([rows.map((row) => [row.number, row.mergePick?.headSha])]);
  // A live run takes the strip with its progress and Stop, even with no rows picked.
  const live = await strip(ask, []);
  expect(live.run?.sentence).toBe("Fetching main, #233 and #224");
  expect(live.run?.actions.map((action) => action.label)).toEqual(["Stop"]);
  verify.advance();
  expect((await strip(ask, [])).run?.sentence).toBe("Combining #233 onto main");
  expect((await write(ask, { kind: "stop", runId: live.run?.id })).ok).toBe(true);
  expect((await strip(ask, [])).run?.sentence).toBe("Stopped; nothing was merged");
});

test("a conflict names both pull requests, and retrying without one merges the other", async () => {
  const { ask, daemon } = await connected();
  const verify = daemon.services.verify;
  verify.stepMs = 1;
  verify.outcome = () => ({ code: "conflict", pr: 224, with: 233 });
  const rows = await ready(ask);
  await write(ask, { kind: "start", method: "squash", prs: rows.map((row) => row.mergePick) });
  const failed = await until(ask, (reply) => reply.run?.sentence === "#224 conflicts with #233");
  const without = failed.run?.actions.find((action) => action.kind === "without");
  expect(without?.label).toBe("Remove #224 and retry");
  verify.outcome = () => undefined;
  expect((await write(ask, { kind: "without", runId: failed.run?.id, pr: 224 })).ok).toBe(true);
  const merged = await until(ask, (reply) => reply.run?.sentence === "Merged 1 pull request");
  // What merged leaves the open list: the phone reads it again.
  expect(merged.merged).toBe(merged.run?.id);
  const retried = verify.started[1]?.target;
  expect(retried?.kind === "merge" && retried.prs.map((pr) => pr.pr.number)).toEqual([233]);
  // Dismissed, the ending leaves the strip.
  expect((await write(ask, { kind: "dismiss", runId: merged.run?.id })).ok).toBe(true);
  expect((await strip(ask, [])).run).toBeNull();
});

test("a row into another base, or past ten, can't join the selection, and says why", async () => {
  const { ask } = await connected();
  const rows = await ready(ask);
  const [first] = rows;
  if (!first?.mergePick) throw new Error("no ready row");
  const other = { key: "other", base: "release", headSha: "c".repeat(40) };
  const reply = (await ask({
    type: "forge.merge-run",
    project: "ace",
    picked: [first.mergePick],
    rows: [
      ...rows.map((row) => ({
        key: row.key,
        base: row.mergePick?.base,
        headSha: row.mergePick?.headSha,
      })),
      other,
    ],
  })) as MergeRunReply;
  expect(reply.blocked).toEqual([{ key: "other", reason: "Pick pull requests into main" }]);
});

test("a project without a check command offers to set one instead of Start", async () => {
  const { ask, daemon } = await connected();
  daemon.services.verify.commands.set("ace", null);
  const rows = await ready(ask);
  expect((await strip(ask, rows)).pick).toEqual({
    sentence: "Verify and merge 2 pull requests into main",
    start: false,
  });
});

async function until(ask: Ask, done: (reply: MergeRunReply) => boolean): Promise<MergeRunReply> {
  for (let tries = 0; tries < 200; tries++) {
    const reply = await strip(ask, []);
    if (done(reply)) return reply;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the run never got there");
}

test("a pick whose head moved since it was picked leaves the selection, and the strip says so", async () => {
  const { ask } = await connected();
  const rows = await ready(ask);
  const [first, second] = rows;
  if (!first?.mergePick || !second?.mergePick) throw new Error("no ready rows");
  // #233 was picked at an older head; the list now shows a newer one.
  const stale = { ...first.mergePick, headSha: "b".repeat(40) };
  const reply = (await ask({
    type: "forge.merge-run",
    project: "ace",
    picked: [stale, second.mergePick],
    rows: rows.map((row) => ({
      key: row.key,
      base: row.mergePick?.base,
      headSha: row.mergePick?.headSha,
    })),
  })) as MergeRunReply;
  expect(reply.picked).toEqual([second.key]);
  expect(reply.notice).toBe("#233 has new commits since it was picked. Pick it again to merge it.");
  expect(reply.pick?.sentence).toBe("Verify and merge 1 pull request into main");
});

test("Start merges the heads as they were picked, never a newer one the list read since", async () => {
  const { ask, daemon } = await connected();
  const verify = daemon.services.verify;
  verify.paused = true;
  const [first] = await ready(ask);
  if (!first?.mergePick) throw new Error("no ready row");
  const picked = { ...first.mergePick, headSha: "d".repeat(40) };
  await write(ask, { kind: "start", method: "squash", prs: [picked] });
  const target = verify.started[0]?.target;
  expect(target?.kind === "merge" && target.prs.map((pr) => pr.headSha)).toEqual(["d".repeat(40)]);
});

test("Start with a pick whose head moved since starts nothing and says to pick it again", async () => {
  const { ask, daemon } = await connected();
  const [first] = await ready(ask);
  if (!first?.mergePick) throw new Error("no ready row");
  const stale = { ...first.mergePick, headSha: "b".repeat(40) };
  const reply = await write(ask, {
    kind: "start",
    method: "squash",
    prs: [stale],
    rows: [{ key: first.key, base: "main", headSha: first.mergePick.headSha }],
  });
  expect(reply).toEqual({
    type: "forge.write",
    ok: false,
    message: "#233 has new commits since it was picked. Pick it again to merge it.",
  });
  expect(daemon.services.verify.started).toEqual([]);
});

test("Start with a pick whose row left the list starts nothing and says to pick it again", async () => {
  const { ask, daemon } = await connected();
  const [first, second] = await ready(ask);
  if (!first?.mergePick || !second?.mergePick) throw new Error("no ready rows");
  // #233 was filtered out of the list after it was picked; only #224 is on show.
  const reply = await write(ask, {
    kind: "start",
    method: "squash",
    prs: [first.mergePick, second.mergePick],
    rows: [{ key: second.key, base: "main", headSha: second.mergePick.headSha }],
  });
  expect(reply).toEqual({
    type: "forge.write",
    ok: false,
    message: "#233 is no longer in the list. Pick it again to merge it.",
  });
  expect(daemon.services.verify.started).toEqual([]);
});
