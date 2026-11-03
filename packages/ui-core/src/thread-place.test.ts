import { expect, test } from "vitest";
import type { ThreadListEntry } from "@ace/protocol";
import type { HomeSort } from "./arrange.ts";
import { panelPage, panelRows, tabThreads } from "./home-rows.ts";
import { placeReader, placeThread, threadTabs } from "./thread-place.ts";
import { Organizer } from "./organizer.ts";
import { entry } from "./test-entries.fixture.ts";

const local = (month: number, date: number, hour = 12) =>
  new Date(2026, month - 1, date, hour).getTime();
// Saturday 31 October 2026, mid-afternoon.
const now = local(10, 31, 15);
const minute = 60_000;
const day = 24 * 60 * minute;

/** The tabs as the daemon places each entry (`placeThread`) and a client reads them. */
function panel(
  entries: readonly ThreadListEntry[],
  options: { sortBy?: HomeSort; project?: string | null } = {},
) {
  const input = { baseline: 0, now, sortBy: options.sortBy ?? "activity" } as const;
  const placed = entries.map((each) => withPlace(each, input));
  // The project filter narrows what comes in; it never reorders.
  const shown = placed.filter(
    (each) => options.project == null || each.workspaceId === options.project,
  );
  return threadTabs(shown, placeReader({ fallback: input }));
}

/** The entry as the daemon sends it, with its place. */
function withPlace(each: ThreadListEntry, input: Parameters<typeof placeThread>[1]) {
  return Object.assign({}, each, { place: placeThread(each, input) });
}

/** Settled by the daemon a while ago, read, at rest. */
const settledAt = (at: number) => ({ readAt: at, settledAt: at, settledReason: "manual" as const });
/** Finished and already opened. */
const seen = (at: number) => ({ readAt: at });

test("the Inbox goes pinned, needs you, running, unseen, then idle, whatever is newest", () => {
  const built = panel([
    entry("idle", { state: "done" }, now, seen(now)),
    entry("unseen", { state: "done" }, now - minute),
    entry("runs", { state: "working", agents: 1 }, now - 2 * minute),
    entry("waits", { state: "waiting", on: "background_task" }, now - 3 * minute),
    entry("failed", { state: "failed" }, now - 4 * minute),
    entry("asks", { state: "needs_you", interactions: 1 }, now - day),
    entry("pin", { state: "done" }, now - 2 * day, { ...seen(now), pinned: true }),
  ]);
  expect(built.inbox).toEqual(["pin", "failed", "asks", "runs", "waits", "unseen", "idle"]);
  expect(built.pinned).toEqual(["pin"]);
});

test("within a band the most recent activity leads", () => {
  const built = panel([
    entry("older", { state: "working", agents: 1 }, now - day),
    entry("newer", { state: "working", agents: 1 }, now - minute),
  ]);
  expect(built.inbox).toEqual(["newer", "older"]);
});

test("a settled parent whose agent tree still works is running in the Inbox, not Settled", () => {
  const built = panel([
    entry("parent", { state: "done" }, now - day, {
      live: { runningSubagentCount: 1 },
      ...settledAt(now - 10 * day),
    }),
    entry("idle", { state: "done" }, now, seen(now)),
  ]);
  expect(built.inbox).toEqual(["parent", "idle"]);
  expect(built.settled).toEqual([]);
});

test("a failure already seen waits with the idle threads", () => {
  const built = panel([
    entry("seen", { state: "failed" }, now, seen(now)),
    entry("works", { state: "working", agents: 1 }, now - day),
  ]);
  expect(built.inbox).toEqual(["works", "seen"]);
});

test("sorted newest first, the Inbox keeps the person's sort below the pinned threads", () => {
  const built = panel(
    [
      entry("asks", { state: "needs_you", interactions: 1 }, now, { createdAt: 1 }),
      entry("new", { state: "done" }, now - day, { ...seen(now), createdAt: 3 }),
    ],
    { sortBy: "created" },
  );
  expect(built.inbox).toEqual(["new", "asks"]);
});

test("a settled thread held at a usage limit or with only a command left running stays in Settled", () => {
  const built = panel([
    entry(
      "limited",
      { state: "limited", until: now + day },
      now - 5 * day,
      settledAt(now - 5 * day),
    ),
    entry("rate", { state: "waiting", on: "rate_limit" }, now - 4 * day, settledAt(now - 4 * day)),
    entry(
      "server",
      { state: "waiting", on: "background_task" },
      now - 3 * day,
      settledAt(now - 3 * day),
    ),
    entry("works", { state: "working", agents: 1 }, now - 2 * day, settledAt(now - 2 * day)),
    entry("asks", { state: "needs_you", interactions: 1 }, now - day, settledAt(now - day)),
  ]);
  expect(built.settled).toEqual(["server", "rate", "limited"]);
  // Real work under a settled thread, or a request, still brings it back to the Inbox.
  expect(built.inbox).toEqual(["asks", "works"]);
});

test("a client shows the daemon's places as given, and places only entries that came without one", () => {
  const input = { baseline: 0, now };
  const fromDaemon = entry("a", { state: "done" }, now, seen(now));
  // The daemon put it in Settled; the entry alone would read as idle in the Inbox.
  const placed = { ...fromDaemon, place: { tab: "settled" as const, rank: [now] } };
  const older = entry("b", { state: "working", agents: 1 }, now - minute);
  const built = threadTabs([placed, older], placeReader({ fallback: input }));
  expect(built.settled).toEqual(["a"]);
  expect(built.inbox).toEqual(["b"]);
});

test("an unconfirmed copy keeps its tabs but folds the Inbox's live bands into one list by activity", () => {
  const input = { baseline: 0, now };
  const entries = [
    entry("asks", { state: "needs_you", interactions: 1 }, now - day),
    entry("idle", { state: "done" }, now, seen(now)),
    entry("pin", { state: "done" }, now - 2 * day, { ...seen(now), pinned: true }),
    entry("rest", { state: "done" }, now, settledAt(now)),
  ].map((each) => withPlace(each, input));
  const built = threadTabs(entries, placeReader({ fallback: input, unconfirmed: true }));
  expect(built.inbox).toEqual(["pin", "idle", "asks"]);
  expect(built.settled).toEqual(["rest"]);
});

test("settling moves a thread from the Inbox to Settled, and Undo brings it back", () => {
  const open = entry("t", { state: "done" }, now - minute, seen(now));
  expect(panel([open]).inbox).toEqual(["t"]);
  const settled = panel([{ ...open, ...settledAt(now) }]);
  expect(settled.inbox).toEqual([]);
  expect(settled.settled).toEqual(["t"]);
  // Undo takes back only the settle: the entry is as it was.
  expect(panel([open]).inbox).toEqual(["t"]);
});

test("Settled lists newest first, a pinned thread the person settled among them", () => {
  const built = panel([
    entry("old", { state: "done" }, now - 5 * day, settledAt(now - 5 * day)),
    entry("pin", { state: "done" }, now - 2 * day, { pinned: true, ...settledAt(now - 2 * day) }),
    entry("new", { state: "done" }, now - day, settledAt(now - day)),
  ]);
  expect(built.settled).toEqual(["new", "pin", "old"]);
  expect(built.inbox).toEqual([]);
});

test("a snoozed thread leaves the Inbox, pinned or not, but a request always shows", () => {
  const later = { snoozedUntil: now + day };
  const built = panel([
    entry("later", { state: "done" }, now, { ...seen(now), ...later }),
    entry("pin", { state: "done" }, now, { ...seen(now), ...later, pinned: true }),
    entry("asks", { state: "needs_you", interactions: 1 }, now, later),
  ]);
  expect(built.inbox).toEqual(["asks"]);
  expect(built.snoozed.toSorted()).toEqual(["later", "pin"]);
});

test("a thread snoozed until it needs you returns to the Inbox once it fails or finishes", () => {
  const snooze = { snoozedUntil: now + 30 * day, snoozeWake: { on: "needs_you" } };
  const running = entry("t", { state: "working", agents: 1 }, now, snooze);
  expect(panel([running]).snoozed).toEqual(["t"]);
  for (const status of [{ state: "failed" }, { state: "done" }] as const) {
    const built = panel([entry("t", status, now, snooze)]);
    expect(built.snoozed).toEqual([]);
    expect(built.inbox).toEqual(["t"]);
  }
});

test("the project filter narrows every tab", () => {
  const entries = [
    entry("a1", { state: "working", agents: 1 }, now, { workspaceId: "a" }),
    entry("b1", { state: "working", agents: 1 }, now, { workspaceId: "b" }),
    entry("a2", { state: "done" }, now, { workspaceId: "a", snoozedUntil: now + day }),
    entry("b2", { state: "done" }, now, { workspaceId: "b", snoozedUntil: now + day }),
    entry("a3", { state: "done" }, now, { workspaceId: "a", ...settledAt(now) }),
    entry("b3", { state: "done" }, now, { workspaceId: "b", ...settledAt(now) }),
  ];
  const built = panel(entries, { project: "a" });
  expect(tabThreads(built, "inbox")).toEqual(["a1"]);
  expect(tabThreads(built, "snoozed")).toEqual(["a2"]);
  expect(tabThreads(built, "settled")).toEqual(["a3"]);
});

test("each tab's rows are its threads, with no headings; Settled offers more the daemon holds", () => {
  const built = panel([
    entry("pin", { state: "done" }, now, { ...seen(now), pinned: true }),
    entry("runs", { state: "working", agents: 1 }, now),
    entry("nap", { state: "done" }, now, { snoozedUntil: now + day }),
    entry("rest", { state: "done" }, now, settledAt(now)),
  ]);
  expect(panelRows(built, "inbox", { includeUnsent: true })).toEqual([
    { kind: "unsent" },
    { kind: "thread", id: "pin", place: "pinned" },
    { kind: "thread", id: "runs", place: "active" },
  ]);
  expect(panelRows(built, "snoozed")).toEqual([{ kind: "snoozed", id: "nap" }]);
  expect(panelRows(built, "settled", { shown: 50, moreOnDaemon: true })).toEqual([
    { kind: "settled", id: "rest" },
    { kind: "more", more: true, less: false },
  ]);
});

const ids = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`);

test("Snoozed and Settled show a page at a time, with Show more and Show less", () => {
  const loaded = { inbox: [], pinned: [], snoozed: ids("nap", 120), settled: ids("rest", 70) };
  const first = panelRows(loaded, "snoozed", { shown: panelPage });
  expect(first.filter((row) => row.kind === "snoozed")).toHaveLength(50);
  expect(first.at(-1)).toEqual({ kind: "more", more: true, less: false });
  const third = panelRows(loaded, "snoozed", { shown: panelPage * 3 });
  expect(third.filter((row) => row.kind === "snoozed")).toHaveLength(120);
  expect(third.at(-1)).toEqual({ kind: "more", more: false, less: true });
  // Every loaded settled thread showing, yet the daemon holds older ones: still Show more.
  const settled = panelRows(loaded, "settled", { shown: panelPage * 2, moreOnDaemon: true });
  expect(settled.filter((row) => row.kind === "settled")).toHaveLength(70);
  expect(settled.at(-1)).toEqual({ kind: "more", more: true, less: true });
  // A short list needs neither.
  const short = { ...loaded, snoozed: ids("nap", 3) };
  expect(panelRows(short, "snoozed", { shown: panelPage }).map((row) => row.kind)).toEqual([
    "snoozed",
    "snoozed",
    "snoozed",
  ]);
  // The Inbox always lists every thread.
  const inbox = { ...loaded, inbox: ids("work", 200) };
  expect(panelRows(inbox, "inbox", { shown: panelPage })).toHaveLength(200);
});

/** Delegated here by an agent on a paired machine, whose thread is its parent. */
const fromPairedMachine = {
  hasSentMessage: true,
  delegatedFrom: { hostId: "host-a", hostName: "Studio Mac", threadId: "parent-on-a" },
};

test("a thread delegated from a paired machine is not listed on the host", () => {
  const built = panel([
    entry("mine", { state: "working", agents: 1 }, now - minute),
    entry("asked", { state: "needs_you", interactions: 1 }, now, fromPairedMachine),
    entry("rested", { state: "done" }, now - day, { ...fromPairedMachine, ...settledAt(now) }),
  ]);
  expect(built.inbox).toEqual(["mine"]);
  expect(built.settled).toEqual([]);
});

test("the panel remembers its open tab; older storage opens the Inbox", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  values.set(
    "ace.home.organizer",
    JSON.stringify({ baseline: 0, project: null, collapsed: ["project:ace"], quietOpen: true }),
  );
  const organizer = new Organizer(storage, now);
  expect(organizer.getState().tab).toBe("inbox");
  organizer.setTab("settled");
  expect(new Organizer(storage, now).getState().tab).toBe("settled");
});
