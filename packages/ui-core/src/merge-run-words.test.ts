import type { VerifyRun } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  mergePickBlocked,
  mergePickWords,
  mergeRunRefusal,
  mergeSelection,
  runWords,
  shownMergeRun,
} from "./merge-run-words.ts";

const repository = { forge: "github", host: "github.com", owner: "acme", name: "ace" } as const;
const pr = (number: number) => ({
  pr: { repository, number },
  headSha: "a".repeat(40),
  title: `PR ${number}`,
});
const run = (id: string, state: VerifyRun["state"], extra: Partial<VerifyRun> = {}): VerifyRun =>
  ({
    id,
    workspaceId: "ace",
    target: { kind: "merge", method: "squash", prs: [pr(1219), pr(1221)] },
    state,
    command: "bun run check",
    steps: [],
    merged: [],
    revision: 1,
    createdAt: 1_000,
    base: { branch: "main", sha: "b".repeat(40) },
    ...extra,
  }) as VerifyRun;
const none = { dismissed: new Set<string>(), own: undefined, picking: false };

test("picking ready pull requests offers to verify and merge them into their base", () => {
  expect(mergePickWords(1, "main")).toBe("Verify and merge 1 pull request into main");
  expect(mergePickWords(3, "release")).toBe("Verify and merge 3 pull requests into release");
});

test("a row joins the selection only into the picked base and while there is room", () => {
  const free = { picked: false, count: 1, base: "main", rowBase: "main" };
  expect(mergePickBlocked(free)).toBeUndefined();
  expect(mergePickBlocked({ ...free, rowBase: "release" })).toBe("Pick pull requests into main");
  expect(mergePickBlocked({ ...free, count: 10 })).toBe("At most 10 pull requests merge at once");
  // A picked row can always be taken off.
  expect(mergePickBlocked({ ...free, picked: true, count: 10 })).toBeUndefined();
  expect(
    mergePickBlocked({ picked: false, count: 0, base: undefined, rowBase: "x" }),
  ).toBeUndefined();
});

test("the strip shows a live merge run, and a settled one only if it was started here", () => {
  expect(shownMergeRun([run("live", "running")], none)?.id).toBe("live");
  expect(shownMergeRun([run("old", "merged")], none)).toBeUndefined();
  expect(shownMergeRun([run("mine", "failed")], { ...none, own: "mine" })?.id).toBe("mine");
});

test("a dismissed run leaves the strip, and a new selection replaces a settled one", () => {
  expect(
    shownMergeRun([run("live", "running")], { ...none, dismissed: new Set(["live"]) }),
  ).toBeUndefined();
  expect(
    shownMergeRun([run("mine", "merged")], { ...none, own: "mine", picking: true }),
  ).toBeUndefined();
  // A live run stays in view while the person picks the next ones.
  expect(shownMergeRun([run("live", "merging")], { ...none, picking: true })?.id).toBe("live");
});

test("a live run says what it is doing and offers Stop until merging begins", () => {
  const checking = runWords(run("r", "running"), "main");
  expect(checking).toMatchObject({
    sentence: "Checking #1219 and #1221 together on main",
    since: 1_000,
  });
  expect(checking.actions.map((action) => action.label)).toEqual(["Stop"]);
  expect(runWords(run("r", "merging"), "main").actions).toEqual([]);
});

test("a conflict names the pull request and offers to retry without it", () => {
  const words = runWords(
    run("r", "failed", {
      failure: { code: "conflict", message: "Doesn't merge cleanly.", pr: 1221, with: 1219 },
    }),
    "main",
  );
  expect(words.sentence).toBe("#1221 conflicts with #1219");
  expect(words.actions[0]).toEqual({ kind: "without", label: "Remove #1221 and retry", pr: 1221 });
});

test("a refused start says why in a sentence", () => {
  expect(mergeRunRefusal("busy")).toBe(
    "Too many runs are waiting in this project. Try again once one ends.",
  );
  expect(mergeRunRefusal(undefined)).toBe("Verify didn't answer. Try again.");
});

test("a picked row whose head moved since it was picked leaves the selection, and the strip says so", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const picked = [
    { key: "ace#233", number: 233, headSha: a },
    { key: "ace#224", number: 224, headSha: a },
    { key: "ace#219", number: 219, headSha: a },
  ];
  // #224 got a push; #219 left the list; the rows are in list order.
  const rows = [
    { key: "ace#224", headSha: b },
    { key: "ace#233", headSha: a },
    { key: "ace#300", headSha: a },
  ];
  const selection = mergeSelection(picked, rows);
  expect(selection.kept.map((pick) => pick.key)).toEqual(["ace#233"]);
  // What stays keeps the head the person saw, never the row's new one.
  expect(selection.kept[0]?.headSha).toBe(a);
  expect(selection.moved).toEqual([224]);
  expect(selection.notice).toBe(
    "#224 has new commits since it was picked. Pick it again to merge it.",
  );
});

test("several moved heads are named together, and none moved says nothing", () => {
  const a = "a".repeat(40);
  const picked = [1, 2].map((number) => ({ key: `k${number}`, number, headSha: a }));
  const moved = mergeSelection(picked, [
    { key: "k1", headSha: "c".repeat(40) },
    { key: "k2", headSha: undefined },
  ]);
  expect(moved.notice).toBe(
    "#1 and #2 have new commits since they were picked. Pick them again to merge them.",
  );
  expect(mergeSelection(picked, picked).notice).toBeUndefined();
});
