import { describe, expect, it } from "vitest";
import {
  cappedWeek,
  dayMs,
  freshOrder,
  rankTrending,
  topPublishers,
  trendScore,
  type HourCount,
} from "./trending.ts";

/* Discover's rankings (ADR 0173 §6, §15): caps, decay, the minimum, movement and the tiers. */

const now = 500_000;
/** `count` downloads in each of `hours`, counted back from now. */
const spread = (count: number, hoursAgo: readonly number[]): HourCount[] =>
  hoursAgo.map((ago) => ({ hour: now - ago, count }));
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);
const week = (hours: readonly HourCount[]) =>
  cappedWeek(hours, now).reduce((sum, row) => sum + row.count, 0);

const lastWeek = (count: number) => spread(count, range(170, 180));
const thisWeek = (count: number) => spread(count, range(1, 11));
const order = (entries: Parameters<typeof rankTrending>[0]) =>
  rankTrending(entries, now).map((row) => row.key);
const today = 20_000;
const days = (count: number, n = 10) =>
  Array.from({ length: n }, (_, index) => ({ day: today - index, count }));
const ranked = (input: Parameters<typeof topPublishers>[0]) =>
  topPublishers(input, today).map((row) => row.id);

describe("trending caps", () => {
  it.each([
    ["an hour with no history counts up to 50", spread(400, [1]), 50],
    ["an ordinary hour counts whole", spread(30, [1, 2, 3]), 90],
    [
      "an hour caps at four times the median of the week before it",
      [...spread(100, [168, 169]), ...spread(1_000, [1])],
      // The baseline (100 an hour) lies just outside this week; the burst caps at 400.
      400,
    ],
    [
      "a burst past the cap adds nothing more however large",
      [...spread(20, range(2, 30)), ...spread(1_000_000, [1])],
      29 * 20 + 80,
    ],
  ])("%s", (_name, hours, expected) => {
    expect(week(hours)).toBe(expected);
  });

  it("a day counts at most 5,000", () => {
    // Steady traffic lifts the hourly cap; the day's own cap still holds.
    const steady = spread(2_000, range(1, 160));
    const days = new Map<number, number>();
    for (const row of cappedWeek(steady, now))
      days.set(Math.floor(row.hour / 24), (days.get(Math.floor(row.hour / 24)) ?? 0) + row.count);
    expect(Math.max(...days.values())).toBe(5_000);
  });

  it("hours outside the week count nothing", () => {
    expect(week(spread(40, [168, 200, 300]))).toBe(0);
  });
});

describe("trending scores", () => {
  it("decay with a 72-hour half-life", () => {
    const fresh = trendScore(spread(10, [0]), undefined, now);
    const older = trendScore(spread(10, [72]), undefined, now);
    expect(older?.score).toBeCloseTo((fresh?.score ?? 0) / 2, 6);
  });

  it("an entry with fewer than 5 capped downloads doesn't trend", () => {
    expect(trendScore(spread(1, [1, 2, 3, 4]), undefined, now)).toBeUndefined();
    expect(trendScore(spread(1, [1, 2, 3, 4, 5]), undefined, now)?.week).toBe(5);
  });

  it("a burst doesn't put a quiet entry above a steadily used one", () => {
    const rows = rankTrending(
      [
        { key: "burst", hours: spread(100_000, [1]) },
        { key: "steady", hours: spread(15, range(1, 24)) },
      ],
      now,
    );
    expect(rows.map((row) => row.key)).toEqual(["steady", "burst"]);
  });
});

describe("trending movement against the same ranking a week earlier", () => {
  it("is new, up, down or same", () => {
    const rows = rankTrending(
      [
        // Last week: a 30, b 20, c 10. This week: c 40, a 30, b 5, and d new at 20.
        { key: "a", hours: [...lastWeek(30), ...thisWeek(30)] },
        { key: "b", hours: [...lastWeek(20), ...thisWeek(5)] },
        { key: "c", hours: [...lastWeek(10), ...thisWeek(40)] },
        { key: "d", hours: thisWeek(20) },
      ],
      now,
    );
    expect(rows.map((row) => [row.key, row.rank, row.movement])).toEqual([
      ["c", 1, { kind: "up", by: 2 }],
      ["a", 2, { kind: "down", by: 1 }],
      ["d", 3, { kind: "new" }],
      ["b", 4, { kind: "down", by: 2 }],
    ]);
    const same = rankTrending([{ key: "a", hours: [...lastWeek(10), ...thisWeek(10)] }], now);
    expect(same[0]?.movement).toEqual({ kind: "same" });
  });
});

describe("tiers in trending", () => {
  const equal = spread(10, range(1, 10));

  it("rank official above verified above the rest among equals", () => {
    expect(
      order([
        { key: "other", hours: equal },
        { key: "verified", tier: "verified", hours: equal },
        { key: "official", tier: "official", hours: equal },
      ]),
    ).toEqual(["official", "verified", "other"]);
  });

  it("never lift a verified entry with clearly fewer downloads over one with many more", () => {
    expect(
      order([
        { key: "verified", tier: "verified", hours: spread(10, range(1, 10)) },
        { key: "popular", hours: spread(14, range(1, 10)) },
      ]),
    ).toEqual(["popular", "verified"]);
  });

  it("keep a much more popular unverified entry above an official one with few downloads", () => {
    expect(
      order([
        { key: "official", tier: "official", hours: spread(1, range(1, 6)) },
        { key: "popular", hours: spread(10, range(1, 6)) },
      ]),
    ).toEqual(["popular", "official"]);
  });
});

describe("top publishers", () => {
  it("rank capped 30-day downloads, a day at most 5,000", () => {
    const rows = topPublishers(
      [
        { id: "a", handle: "a", entries: [days(100)] },
        { id: "b", handle: "b", entries: [[{ day: today, count: 1_000_000 }]] },
        { id: "old", handle: "old", entries: [[{ day: today - 40, count: 90_000 }]] },
      ],
      today,
    );
    expect(rows).toEqual([
      { id: "b", rank: 1, downloads: 5_000, entries: 1 },
      { id: "a", rank: 2, downloads: 1_000, entries: 1 },
    ]);
  });

  it("keep at most 12", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      id: `p${index}`,
      handle: `p${index}`,
      entries: [days(index + 1)],
    }));
    expect(topPublishers(many, today)).toHaveLength(12);
  });

  it("apply the tiers: official over verified over others among equals, never past many more", () => {
    expect(
      ranked([
        { id: "other", handle: "a-other", entries: [days(50)] },
        { id: "verified", handle: "b-verified", tier: "verified", entries: [days(50)] },
        { id: "official", handle: "c-official", tier: "official", entries: [days(50)] },
      ]),
    ).toEqual(["official", "verified", "other"]);
    expect(
      ranked([
        { id: "verified", handle: "verified", tier: "verified", entries: [days(50)] },
        { id: "popular", handle: "popular", entries: [days(70)] },
      ]),
    ).toEqual(["popular", "verified"]);
    expect(
      ranked([
        { id: "official", handle: "official", tier: "official", entries: [days(2)] },
        { id: "popular", handle: "popular", entries: [days(20)] },
      ]),
    ).toEqual(["popular", "official"]);
  });
});

describe("New and notable", () => {
  const at = 400 * dayMs;
  it("is newest first within 30 days, the tier breaking ties within a day", () => {
    const rows = freshOrder(
      [
        { key: "old", firstListed: at - 31 * dayMs },
        { key: "yesterday", firstListed: at - dayMs - 1_000 },
        { key: "today-other", firstListed: at - 1_000 },
        { key: "today-official", firstListed: at - 5_000, tier: "official" as const },
        { key: "today-verified", firstListed: at - 3_000, tier: "verified" as const },
      ],
      at,
    );
    expect(rows.map((row) => row.key)).toEqual([
      "today-official",
      "today-verified",
      "today-other",
      "yesterday",
    ]);
  });
});
