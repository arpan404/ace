import type { StorageItem, StoragePlan } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  compactionLines,
  confirmQuestion,
  planLines,
  receiptLine,
  reviewLines,
  usageLines,
} from "./storage.ts";

const revision = "a".repeat(64);
function item(overrides: Partial<StorageItem>): StorageItem {
  return {
    id: "i1",
    kind: "logs",
    label: "logs/ace.1.jsonl",
    bytes: 2048,
    modifiedAt: 0,
    threadIds: [],
    disposition: "remove",
    reasons: ["expired"],
    forced: false,
    effects: [],
    ...overrides,
  };
}
function plan(items: StorageItem[]): StoragePlan {
  return {
    id: "p1",
    revision,
    createdAt: 0,
    expiresAt: 0,
    retention: {
      threads: 90,
      attachments: 30,
      artifacts: 30,
      logs: 14,
      worktrees: 30,
      caches: 7,
      idleThreads: false,
      worktreeMode: "archived",
    },
    items,
    bytes: items
      .filter((entry) => entry.disposition === "remove")
      .reduce((sum, entry) => sum + entry.bytes, 0),
    complete: true,
  };
}

test("a plan lists what goes and what stays, with why, and the command that applies it", () => {
  const reviewed = plan([
    item({}),
    item({
      id: "i2",
      kind: "worktrees",
      label: "wt/feature",
      disposition: "protect",
      reasons: ["not_merged", "uncommitted"],
    }),
  ]);
  expect(reviewLines(reviewed)).toEqual([
    `Plan p1 (revision ${revision})`,
    "Remove 1 item, 2.0 KB:",
    "  logs        logs/ace.1.jsonl  2.0 KB",
    "Keep 1 item:",
    "  worktrees   wt/feature  not merged, uncommitted",
    `Apply it with ace storage apply p1 --revision ${revision}`,
  ]);
  expect(confirmQuestion(reviewed)).toBe("Remove 1 item (2.0 KB)?");
});

test("a plan with nothing to remove says so instead of offering to apply it", () => {
  const empty = plan([item({ disposition: "protect", reasons: ["pinned"] })]);
  expect(reviewLines(empty).at(-1)).toBe("Nothing to remove.");
  expect(planLines({ ...empty, complete: false }).at(-1)).toMatch(/incomplete/);
});

test("a receipt counts what happened; a stale one says nothing was removed and what to do", () => {
  expect(
    receiptLine({
      planId: "p1",
      revision,
      state: "complete",
      items: [
        { id: "a", state: "removed" },
        { id: "b", state: "protected" },
      ],
    }),
  ).toBe(`Cleanup complete: 1 removed, 1 kept, 0 pending (plan p1, revision ${revision}).`);
  expect(receiptLine({ planId: "p1", state: "stale", items: [] })).toMatch(
    /^✕ The plan changed .* nothing was removed .* ace storage plan\.$/,
  );
});

test("usage totals every kind and the database, and points at compaction when it would free space", () => {
  const lines = usageLines({
    categories: [
      { kind: "logs", bytes: 1024 * 1024, items: 3 },
      { kind: "caches", bytes: 0, items: 1 },
    ],
    databaseBytes: 1024 * 1024,
    reclaimableDatabaseBytes: 512 * 1024,
    measuredAt: 0,
    complete: true,
    backups: [],
  });
  expect(lines).toContain("logs            1.0 MB  3 items");
  expect(lines).toContain("caches             0 B  1 item");
  expect(lines).toContain("total           2.0 MB");
  expect(lines.some((line) => line.includes("ace storage compact"))).toBe(true);
});

test("compaction says what it freed, or why it changed nothing", () => {
  const base = {
    id: "c1",
    state: "complete" as const,
    incrementalUnavailable: false,
    databaseBytesBefore: 4096,
    databaseBytes: 1024,
    reclaimableDatabaseBytes: 0,
    checkpointed: true,
  };
  expect(compactionLines(base)).toEqual([
    "Compacted the database: 4.0 KB to 1.0 KB, 3.0 KB freed.",
  ]);
  expect(compactionLines({ ...base, incrementalUnavailable: true })[0]).toMatch(
    /nothing was changed/,
  );
  expect(compactionLines({ ...base, state: "pending", checkpointed: false })).toEqual([
    "Compaction c1 is still running.",
    "A reader kept the log from being truncated; run it again later.",
  ]);
});
