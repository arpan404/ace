import { expect, test } from "vitest";
import { Item } from "@ace/protocol";
import { displayNotice, recoveryAttention, threadCard } from "./index.ts";
import { entry } from "./test-entries.fixture.ts";

const queue = {
  revision: 3,
  paused: true,
  reason: "not_sent" as const,
  resumeAt: null,
  pendingCount: 1,
};
test("a held unsent queue shares its Not sent wording and failed tone across row presentations", () => {
  const thread = entry("held", { state: "waiting", on: "queue" }, 100, { queue });
  const card = threadCard({ entry: thread, baseline: 0, settled: false, now: 200 });
  expect(card.status).toMatchObject({
    compact: "Not sent",
    label: "Not sent",
    tone: "failed",
    mark: "failed",
  });
  expect(recoveryAttention(thread, undefined)).toEqual({
    label: card.status.label,
    tone: card.status.tone,
    mark: card.status.mark,
  });
});

test("a local save failure gets the same attention even when the daemon is idle", () => {
  const thread = entry("local", { state: "done" }, 100);
  const card = threadCard({
    entry: thread,
    baseline: 200,
    settled: false,
    now: 200,
    failedSend: true,
  });
  expect(card.status).toMatchObject({ compact: "Not sent", tone: "failed", mark: "failed" });
  expect(card.emphasis).toBe(true);
  expect(card.dimmed).toBe(false);
});

function notice(text: string) {
  const item = Item.parse({
    id: "notice",
    agentId: "root",
    createdAt: 0,
    updatedAt: 0,
    type: "notice",
    text,
    level: "warning",
    complete: true,
    raw: [{ type: "cursor.sdk.v1", data: { futureBoundaryField: true } }],
  });
  if (item.type !== "notice") throw new Error("Expected notice fixture");
  return item;
}

test("old Cursor boundary diagnostics do not appear in the conversation", () => {
  for (const text of [
    "Malformed SDK boundary envelope",
    "Checkpoint snapshot retained for reconciliation",
    "Shell output has no observed owning child",
    "SDK task summary has no independent child identity",
  ])
    expect(displayNotice(notice(text))).toBeUndefined();
});

test("an old interrupted Cursor notice explains unfinished work in plain language", () => {
  expect(
    displayNotice(notice("SDK host exited; unresolved child/background work is uncertain"))?.text,
  ).toBe("Cursor stopped unexpectedly. Unfinished work needs your attention.");
});
