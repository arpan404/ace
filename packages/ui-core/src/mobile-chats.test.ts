import { expect, test } from "vitest";
import type { ThreadStatus } from "@ace/protocol";
import { chatSections } from "./mobile-chats.ts";
import type { InboxThread } from "./mobile-inbox.ts";
import { entry } from "./test-entries.fixture.ts";

const local = (month: number, date: number, hour = 12) =>
  new Date(2026, month - 1, date, hour).getTime();
const now = local(10, 31, 15);
const minute = 60_000;

function chat(
  machineId: string,
  id: string,
  at: number,
  extra: Record<string, unknown> = {},
  status: ThreadStatus = { state: "done" },
): InboxThread {
  const workspace = `chat-${id}`;
  return {
    key: id,
    machineId,
    entry: entry(id, status, at, {
      title: `Chat ${id}`,
      readAt: at,
      workspaceId: workspace,
      details: { workspace: { id: workspace, name: "Chat", path: `/c/${id}`, kind: "chat" } },
      ...extra,
    }),
  };
}
const settled = (machineId: string, id: string, at: number) =>
  chat(machineId, id, at, { settledAt: at });

/** Sections grouped on each machine's own runtime, merged by rank as the phone merges them. */
function merged(...machines: InboxThread[][]) {
  const groups = new Map<string, { order: number; rows: { key: string; rank: string }[] }>();
  for (const threads of machines)
    for (const section of chatSections(threads, { now, baseline: 0 })) {
      const group = groups.get(section.label) ?? { order: section.order, rows: [] };
      section.keys.forEach((key, i) => group.rows.push({ key, rank: section.ranks[i] ?? "" }));
      groups.set(section.label, group);
    }
  return [...groups]
    .toSorted((a, b) => a[1].order - b[1].order)
    .map(([label, group]) => [
      label,
      group.rows.toSorted((a, b) => (a.rank < b.rank ? -1 : 1)).map((row) => row.key),
    ]);
}

test("chats from two machines merge into one list: pinned, then needs-you, then at work, then settled by day", () => {
  const laptop = [
    chat("laptop", "working", now - 5 * minute, {}, { state: "working", agents: 1 }),
    settled("laptop", "this-morning", local(10, 31, 8)),
    chat("laptop", "pinned", local(10, 1), { pinned: true, pinOrder: 5 }),
  ];
  const desktop = [
    chat("desktop", "asks", now - 30 * minute, {}, { state: "needs_you", interactions: 1 }),
    settled("desktop", "last-night", local(10, 30, 23)),
    settled("desktop", "lunch", local(10, 31, 12)),
  ];
  expect(merged(laptop, desktop)).toEqual([
    ["Active", ["pinned", "asks", "working"]],
    ["Today", ["lunch", "this-morning"]],
    ["Yesterday", ["last-night"]],
  ]);
});

test("a pinned chat leads Active even when it rests and another needs the person", () => {
  const sections = chatSections(
    [
      chat("m", "asks", now - minute, {}, { state: "needs_you", interactions: 1 }),
      chat("m", "pinned", now - 60 * minute, { pinned: true, pinOrder: 1 }),
    ],
    { now, baseline: 0 },
  );
  expect(sections.map((section) => [section.label, section.keys])).toEqual([
    ["Active", ["pinned", "asks"]],
  ]);
});

test("project threads stay out of Chats", () => {
  const project: InboxThread = {
    key: "work",
    machineId: "m",
    entry: entry("work", { state: "working", agents: 1 }, now),
  };
  expect(
    chatSections([project, chat("m", "c", now, {}, { state: "working", agents: 1 })], {
      now,
      baseline: 0,
    }),
  ).toMatchObject([{ key: "active", keys: ["c"] }]);
});

test("the search narrows chats by title and leaves the rest out", () => {
  const sections = chatSections(
    [settled("m", "recipes", now - minute), settled("m", "taxes", now - 2 * minute)],
    { now, baseline: 0, query: "recipes" },
  );
  expect(sections.flatMap((section) => section.keys)).toEqual(["recipes"]);
});

test("settled chats are drawn dimmed and Active ones are not", () => {
  const sections = chatSections(
    [
      chat("m", "live", now, {}, { state: "working", agents: 1 }),
      settled("m", "done", now - minute),
    ],
    { now, baseline: 0 },
  );
  expect(sections.map((section) => [section.key, section.settled])).toEqual([
    ["active", false],
    ["today", true],
  ]);
});

test("an unconfirmed copy of a chat never reads as settled and done", () => {
  const copy = { ...settled("m", "kept", now - minute), unconfirmed: true };
  expect(chatSections([copy], { now, baseline: 0 }).map((section) => section.key)).toEqual([
    "today",
  ]);
});
