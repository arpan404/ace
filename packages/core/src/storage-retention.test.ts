import { expect, test } from "vitest";
import { StorageRetention, type StorageReason } from "@ace/protocol";
import { planStorageItem, type StorageCandidate } from "./index.ts";

const candidate: StorageCandidate = {
  id: "worktree",
  kind: "worktrees",
  label: "Old task",
  bytes: 100,
  modifiedAt: 0,
  threadIds: [],
  fingerprint: "revision",
  protections: [],
  eligibleReason: "task_finished",
};
const retention = StorageRetention.parse({});
const now = 365 * 86400000;

test.each<StorageReason>([
  "pinned",
  "active_tree",
  "pending_input",
  "live_thread",
  "leased",
  "locked_worktree",
  "main_worktree",
  "owner_unavailable",
])("per-item force cannot bypass %s", (reason) => {
  const item = planStorageItem(
    { ...candidate, protections: [reason, "uncommitted"] },
    retention,
    now,
    new Set([candidate.id]),
  );
  expect(item.disposition).toBe("protect");
  expect(item.reasons).toContain(reason);
});
test("force permits only the named dirty worktree and reports that choice", () => {
  const dirty = {
    ...candidate,
    protections: ["uncommitted", "unpushed"] satisfies StorageReason[],
  };
  expect(planStorageItem(dirty, retention, now, new Set()).disposition).toBe("protect");
  expect(planStorageItem(dirty, retention, now, new Set(["another"])).disposition).toBe("protect");
  expect(planStorageItem(dirty, retention, now, new Set(["worktree"]))).toMatchObject({
    disposition: "remove",
    forced: true,
    reasons: ["task_finished"],
  });
});
test("recent files and disabled categories remain protected", () => {
  expect(
    planStorageItem({ ...candidate, modifiedAt: now }, retention, now, new Set()).reasons,
  ).toContain("within_retention");
  expect(
    planStorageItem(candidate, { ...retention, worktrees: null }, now, new Set()).reasons,
  ).toContain("retention_disabled");
});
test("automatic retention removes an idle unarchived thread past the window but keeps live ones", () => {
  const thread: StorageCandidate = {
    ...candidate,
    id: "thread",
    kind: "threads",
    protections: ["not_archived", "live_thread"],
    eligibleReason: "expired",
  };
  const automatic = StorageRetention.parse({ threads: 120, idleThreads: true });
  expect(planStorageItem(thread, retention, now, new Set()).disposition).toBe("protect");
  expect(planStorageItem(thread, automatic, now, new Set())).toMatchObject({
    disposition: "remove",
    reasons: ["expired"],
  });
  expect(
    planStorageItem({ ...thread, modifiedAt: now - 119 * 86400000 }, automatic, now, new Set())
      .reasons,
  ).toEqual(["within_retention"]);
  for (const reason of ["active_tree", "pending_input", "pinned", "leased"] as const)
    expect(
      planStorageItem(
        { ...thread, protections: [...thread.protections, reason] },
        automatic,
        now,
        new Set(),
      ).reasons,
    ).toEqual([reason]);
});
