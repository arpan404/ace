import { ThreadId, type StorageReason } from "@ace/protocol";
import { describe, expect, test } from "vitest";
import { DelegationTrees, treeProtections, type DelegationRow } from "./delegation-trees.ts";

const id = (value: string) => ThreadId.parse(value);
const row = (thread: string, root: string): DelegationRow => ({
  threadId: id(thread),
  rootId: id(root),
});
const facts = (entries: Record<string, StorageReason[]>) =>
  new Map(Object.entries(entries).map(([thread, reasons]) => [id(thread), new Set(reasons)]));
/** Protections of a thread's storage candidate: its tree, each member expanded again. */
const candidate = (trees: DelegationTrees, reasons: ReturnType<typeof facts>, thread: string) =>
  treeProtections(trees, reasons, trees.tree(id(thread)));

describe("storage tree protections", () => {
  test("a live grandchild in a deep delegation chain protects the root and every ancestor", () => {
    // root -> child -> grandchild -> great-grandchild: every participant names the root.
    const trees = new DelegationTrees([
      row("root", "root"),
      row("child", "root"),
      row("grandchild", "root"),
      row("great", "root"),
    ]);
    const reasons = facts({ root: [], child: [], grandchild: ["active_tree"], great: [] });
    for (const thread of ["root", "child", "grandchild", "great"])
      expect(candidate(trees, reasons, thread)).toEqual(["active_tree"]);
  });

  test("a settled tree with no reasons is removable from every member", () => {
    const trees = new DelegationTrees([row("root", "root"), row("a", "root"), row("b", "root")]);
    const reasons = facts({ root: [], a: [], b: [] });
    for (const thread of ["root", "a", "b"]) expect(candidate(trees, reasons, thread)).toEqual([]);
  });

  test("a pinned thread in one tree leaves its sibling tree and a lone thread removable", () => {
    const trees = new DelegationTrees([
      row("kept", "kept"),
      row("kept-child", "kept"),
      row("free", "free"),
      row("free-child", "free"),
    ]);
    const reasons = facts({
      kept: [],
      "kept-child": ["pinned"],
      free: [],
      "free-child": [],
      alone: ["pending_input"],
      other: [],
    });
    expect(candidate(trees, reasons, "kept")).toEqual(["pinned"]);
    expect(candidate(trees, reasons, "free-child")).toEqual([]);
    expect(candidate(trees, reasons, "alone")).toEqual(["pending_input"]);
    expect(candidate(trees, reasons, "other")).toEqual([]);
  });

  test("a root that joined another tree carries that outer tree's protections to its members", () => {
    // inner's own row names outer, so expanding inner's tree reaches outer's participants.
    const trees = new DelegationTrees([
      row("leaf", "inner"),
      row("inner", "outer"),
      row("busy", "outer"),
    ]);
    const reasons = facts({ leaf: [], inner: [], outer: [], busy: ["leased"] });
    expect(candidate(trees, reasons, "leaf")).toEqual(["leased"]);
    // A single expansion, as removal-time checks use, stops at the thread's own tree.
    expect(treeProtections(trees, reasons, [id("leaf")])).toEqual([]);
  });

  test("a dangling root without a thread row contributes nothing and hides no member", () => {
    const trees = new DelegationTrees([row("a", "gone"), row("b", "gone")]);
    expect(trees.tree(id("a"))).toEqual([id("a"), id("gone"), id("b")]);
    expect(candidate(trees, facts({ a: [], b: [] }), "a")).toEqual([]);
    expect(candidate(trees, facts({ a: [], b: ["cleanup_in_progress"] }), "a")).toEqual([
      "cleanup_in_progress",
    ]);
  });

  test("roots that name each other terminate and share their protections", () => {
    const trees = new DelegationTrees([row("a", "b"), row("b", "a")]);
    const reasons = facts({ a: ["pinned"], b: [] });
    expect(candidate(trees, reasons, "b")).toEqual(["pinned"]);
    expect(candidate(trees, reasons, "a")).toEqual(["pinned"]);
  });

  test("reasons from several members are listed once, in rule order", () => {
    const trees = new DelegationTrees([row("r", "r"), row("x", "r"), row("y", "r")]);
    const reasons = facts({
      r: ["cleanup_in_progress"],
      x: ["active_tree", "pinned"],
      y: ["active_tree"],
    });
    expect(candidate(trees, reasons, "y")).toEqual([
      "pinned",
      "active_tree",
      "cleanup_in_progress",
    ]);
  });
});

/** Seeded generator, so a failing tree can be reproduced. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const allReasons: StorageReason[] = [
  "pinned",
  "active_tree",
  "leased",
  "owner_unavailable",
  "pending_input",
  "cleanup_in_progress",
];

/** The original per-thread rule, read straight from the rows like one SQL lookup per thread. */
function referenceTree(rows: readonly DelegationRow[], thread: ThreadId): ThreadId[] {
  const root = rows.find((entry) => entry.threadId === thread)?.rootId;
  if (root === undefined) return [thread];
  return [
    ...new Set([
      thread,
      root,
      ...rows.filter((entry) => entry.rootId === root).map((entry) => entry.threadId),
    ]),
  ];
}
function referenceProtections(
  rows: readonly DelegationRow[],
  reasons: ReadonlyMap<ThreadId, ReadonlySet<StorageReason>>,
  ids: readonly ThreadId[],
): StorageReason[] {
  const found = new Set<StorageReason>();
  for (const thread of ids)
    for (const member of referenceTree(rows, thread))
      for (const reason of reasons.get(member) ?? []) found.add(reason);
  return [...found].toSorted();
}

test("protections match the per-thread rule on random delegation forests", () => {
  const next = random(0x5eed);
  for (let round = 0; round < 200; round++) {
    const size = 1 + Math.floor(next() * 40);
    const threads = Array.from({ length: size }, (_, index) => id(`t${index}`));
    const pick = () => threads[Math.floor(next() * size)] ?? threads[0] ?? id("t0");
    const rows: DelegationRow[] = [];
    for (const thread of threads) {
      const roll = next();
      // Mostly real trees; some threads alone, some rooted at a thread with no row at all.
      if (roll < 0.7) rows.push({ threadId: thread, rootId: pick() });
      else if (roll < 0.8) rows.push({ threadId: thread, rootId: id(`missing${round}`) });
    }
    const reasons = new Map<ThreadId, Set<StorageReason>>();
    for (const thread of threads) {
      if (next() < 0.1) continue; // no thread row
      const own = new Set<StorageReason>();
      for (const reason of allReasons) if (next() < 0.06) own.add(reason);
      reasons.set(thread, own);
    }
    const trees = new DelegationTrees(rows);
    const memo = new Map<ThreadId, ReadonlySet<StorageReason>>();
    for (const thread of threads) {
      expect(trees.tree(thread)).toEqual(referenceTree(rows, thread));
      const members = referenceTree(rows, thread);
      // Candidate inspection (tree expanded again), shared memo as a page scan uses it.
      expect(treeProtections(trees, reasons, members, memo).toSorted()).toEqual(
        referenceProtections(rows, reasons, members),
      );
      // Removal-time check of one thread.
      expect(treeProtections(trees, reasons, [thread]).toSorted()).toEqual(
        referenceProtections(rows, reasons, [thread]),
      );
    }
    const some = [pick(), pick(), pick()];
    expect(new Set(trees.members(some))).toEqual(
      new Set(some.flatMap((thread) => referenceTree(rows, thread))),
    );
  }
});
