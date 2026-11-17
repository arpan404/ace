import { describe, expect, test } from "vitest";
import { ThreadListEntry } from "@ace/protocol";
import { threadListLines } from "../render/thread-list.ts";
import { pageRows, threadRows, type RowFilter } from "./rows.ts";

const now = 1_800_000_000_000;
const minute = 60_000;

function entry(id: string, fields: Record<string, unknown> = {}): ThreadListEntry {
  return ThreadListEntry.parse({
    id,
    workspaceId: "w_ace",
    title: `Thread ${id}`,
    provider: "codex",
    status: { state: "done" },
    createdAt: now - 60 * minute,
    updatedAt: now - 30 * minute,
    hasSentMessage: true,
    ...fields,
  });
}

function rows(entries: ThreadListEntry[], filter?: RowFilter) {
  return threadRows({
    entries,
    projectNames: new Map([["w_ace", "ace"]]),
    now,
    baseline: now - 24 * 60 * minute,
    ...(filter ? { filter } : {}),
  });
}

function lines(entries: ThreadListEntry[]) {
  const result = rows(entries);
  return threadListLines(
    {
      rows: result.rows,
      next: null,
      settled: result.settled,
      snoozed: result.snoozed,
      command: "ace thread list",
    },
    { now, colour: false },
  );
}

describe("a thread's status in the list", () => {
  test.each([
    {
      name: "a finished parent whose subagents still work reads as waiting on them, never done",
      fields: {
        status: { state: "done" },
        live: { runningSubagentCount: 2, workingSince: now - 4 * minute },
      },
      state: "working",
      mark: "◌2",
    },
    {
      name: "a working thread shows its running time",
      fields: { status: { state: "working", agents: 1 }, live: { workingSince: now - 4 * minute } },
      state: "working",
      mark: "◌ 4m",
    },
    {
      name: "an approval needs you",
      fields: {
        status: { state: "needs_you", interactions: 1 },
        live: { asking: [{ id: "i_1", kind: "approval" }] },
      },
      state: "needs-you",
      mark: "◆",
    },
    {
      name: "a question needs you with its own mark",
      fields: {
        status: { state: "needs_you", interactions: 1 },
        live: { asking: [{ id: "i_1", kind: "question" }] },
      },
      state: "needs-you",
      mark: "?",
    },
    {
      name: "a finished result not yet seen is marked done",
      fields: { status: { state: "done" }, unread: true },
      state: "finished",
      mark: "✓",
    },
    {
      name: "an idle thread shows only its age",
      fields: { status: { state: "done" }, readAt: now },
      state: "idle",
      mark: "30m",
    },
  ])("$name", ({ fields, state, mark }) => {
    const [row] = rows([entry("t_one111", fields)]).rows;
    expect(row?.state).toBe(state);
    expect(lines([entry("t_one111", fields)])[0]?.startsWith(mark)).toBe(true);
  });
});

describe("the list's order and filters", () => {
  const pinned = entry("t_pinned", { pinned: true, pinOrder: 1, readAt: now });
  const asking = entry("t_asking", {
    status: { state: "needs_you", interactions: 1 },
    live: { asking: [{ id: "i_1", kind: "approval" }] },
  });
  const working = entry("t_working", {
    status: { state: "working", agents: 1 },
    live: { workingSince: now },
  });
  const unseen = entry("t_unseen", { unread: true, updatedAt: now - 90 * minute });
  const resting = entry("t_resting", { readAt: now, updatedAt: now - minute });
  const settled = entry("t_settled", { settledAt: now - minute, readAt: now });

  test("pinned, then needs you, then running, then finished unseen, then the rest", () => {
    const order = rows([resting, unseen, working, asking, pinned, settled]).rows.map(
      (row) => row.threadId,
    );
    expect(order).toEqual(["t_pinned", "t_asking", "t_working", "t_unseen", "t_resting"]);
  });

  test("settled threads are left out but counted, and listed with --settled", () => {
    const all = rows([resting, settled]);
    expect(all.rows.map((row) => row.threadId)).toEqual(["t_resting"]);
    expect(all.settled).toBe(1);
    expect(rows([resting, settled], { settled: true }).rows.map((row) => row.threadId)).toEqual([
      "t_settled",
    ]);
  });

  test.each([
    { filter: { needsYou: true }, ids: ["t_asking"] },
    { filter: { running: true }, ids: ["t_working"] },
    { filter: { needsYou: true, running: true }, ids: ["t_asking", "t_working"] },
  ])("filter $filter keeps only those threads", ({ filter, ids }) => {
    expect(rows([resting, working, asking], filter).rows.map((row) => row.threadId)).toEqual(ids);
  });

  test("pages continue after the cursor and stop at the end", () => {
    const all = rows([resting, unseen, working, asking]).rows;
    const first = pageRows(all, 2, undefined);
    expect(first.rows.map((row) => row.threadId)).toEqual(["t_asking", "t_working"]);
    expect(first.next).toBe("t_working");
    const second = pageRows(all, 2, first.next ?? undefined);
    expect(second.rows.map((row) => row.threadId)).toEqual(["t_unseen", "t_resting"]);
    expect(second.next).toBeNull();
  });

  test("a row prints its id, project and title, and says what's hidden", () => {
    const printed = lines([working, settled]);
    expect(printed[0]).toMatch(/t_workin\S*\s+ace\s+Thread t_working/);
    expect(printed.at(-1)).toBe(
      "Not shown: 1 settled. See settled ones with ace thread list --settled.",
    );
  });
});
