import { expect, test } from "vitest";
import type { HomeSort } from "./arrange.ts";
import { entry } from "./test-entries.fixture.ts";
import { inboxSections, type InboxThread } from "./mobile-inbox.ts";

/*
 * The native inbox follows the machine's `threads.sortBy` as Home does: by live activity the
 * live groups stand apart; newest first or by hand, they are one list that holds still while
 * states change.
 */

const now = 1_000_000;
const minute = 60_000;
const on = (machineId: string, value: ReturnType<typeof entry>): InboxThread => ({
  key: `${machineId}/${value.id}`,
  machineId,
  entry: value,
});
const sections = (threads: InboxThread[], sortBy?: HomeSort) =>
  Object.fromEntries(inboxSections(threads, [], now, { sortBy }).map((s) => [s.label, s.keys]));

const asks = on(
  "mac",
  entry("asks", { state: "needs_you", interactions: 1 }, now, { createdAt: 1 * minute }),
);
const busy = on(
  "mac",
  entry("busy", { state: "working", agents: 1 }, now - minute, { createdAt: 3 * minute }),
);
const finished = on(
  "mac",
  entry("finished", { state: "done" }, now - 5 * minute, { createdAt: 5 * minute }),
);
const napping = on(
  "mac",
  entry("napping", { state: "done" }, now, { createdAt: 9 * minute, snoozedUntil: now + minute }),
);
const put = on(
  "mac",
  entry("put", { state: "done" }, now, { createdAt: 8 * minute, settledAt: now }),
);

test("sorted by live activity, threads that need you or are working rise to the top", () => {
  expect(sections([finished, busy, asks, napping, put], "activity")).toEqual({
    "Needs you": ["mac/asks"],
    Working: ["mac/busy"],
    Done: ["mac/finished"],
    Snoozed: ["mac/napping"],
    Settled: ["mac/put"],
  });
});

test("sorted newest first, threads stay where they started whatever their state, the newest leading", () => {
  const result = sections([asks, busy, finished, napping, put], "created");
  expect(result).toEqual({
    Threads: ["mac/finished", "mac/busy", "mac/asks"],
    Snoozed: ["mac/napping"],
    Settled: ["mac/put"],
  });
  // A request arriving later doesn't move its thread.
  const asking = on(
    "mac",
    entry("finished", { state: "needs_you", interactions: 1 }, now + minute, {
      createdAt: 5 * minute,
    }),
  );
  expect(sections([asks, busy, asking], "created").Threads).toEqual([
    "mac/finished",
    "mac/busy",
    "mac/asks",
  ]);
});

const placedAt = (id: string, listOrder: number | undefined, createdAt = 0) =>
  on(
    "mac",
    entry(id, { state: "done" }, now, {
      createdAt,
      ...(listOrder === undefined ? {} : { listOrder }),
    }),
  );

test("sorted by hand, threads keep the person's places, fractions and negatives included", () => {
  const placed = placedAt;
  const result = sections(
    [
      placed("bottom", -2.5),
      placed("middle", 1.5),
      placed("top", 2),
      placed("under", 1),
      placed("zero", 0),
      // Never placed: its creation time stands in, so a new thread leads.
      placed("new", undefined, 10 * minute),
    ],
    "manual",
  );
  expect(result.Threads).toEqual([
    "mac/new",
    "mac/top",
    "mac/middle",
    "mac/under",
    "mac/zero",
    "mac/bottom",
  ]);
});

test("two machines sorted by hand merge into the one order their places say", () => {
  const placed = (machine: string, id: string, listOrder: number) =>
    on(machine, entry(id, { state: "done" }, now, { listOrder }));
  const mac = inboxSections([placed("mac", "a", 3), placed("mac", "c", 1.25)], [], now, {
    sortBy: "manual",
  });
  const pc = inboxSections([placed("pc", "b", 2.75), placed("pc", "d", -1)], [], now, {
    sortBy: "manual",
  });
  const rows = [...mac, ...pc].flatMap((section) =>
    section.keys.map((key, index) => ({ key, rank: section.ranks[index] ?? "" })),
  );
  expect(
    rows.toSorted((x, y) => (x.rank < y.rank ? -1 : x.rank > y.rank ? 1 : 0)).map((r) => r.key),
  ).toEqual(["mac/a", "pc/b", "mac/c", "pc/d"]);
});

const pinnedAt = (machine: string, id: string, pinOrder: number | undefined, extra = {}) =>
  on(
    machine,
    entry(id, { state: "done" }, now, {
      pinned: true,
      ...(pinOrder === undefined ? {} : { pinOrder }),
      ...extra,
    }),
  );

test("pinned threads lead the inbox in their own order, whatever the sort or their state", () => {
  const asking = on(
    "mac",
    entry("asking", { state: "needs_you", interactions: 1 }, now, { pinned: true, pinOrder: 1 }),
  );
  const threads = [busy, asking, pinnedAt("mac", "top", 5), pinnedAt("mac", "old", undefined)];
  for (const sortBy of ["activity", "created", "manual"] as const) {
    const result = inboxSections(threads, [], now, { sortBy });
    expect(result[0]?.label).toBe("Pinned");
    expect(result[0]?.keys).toEqual(["mac/top", "mac/asking", "mac/old"]);
  }
  expect(sections(threads, "activity").Working).toEqual(["mac/busy"]);
});

test("two machines' pins merge into the one order their places say", () => {
  const mac = inboxSections([pinnedAt("mac", "a", 9), pinnedAt("mac", "c", 4.5)], [], now);
  const pc = inboxSections([pinnedAt("pc", "b", 7), pinnedAt("pc", "d", -1)], [], now);
  const rows = [...mac, ...pc].flatMap((section) =>
    section.keys.map((key, index) => ({ key, rank: section.ranks[index] ?? "" })),
  );
  expect(
    rows.toSorted((x, y) => (x.rank < y.rank ? -1 : x.rank > y.rank ? 1 : 0)).map((r) => r.key),
  ).toEqual(["mac/a", "pc/b", "mac/c", "pc/d"]);
});
