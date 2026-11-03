import { describe, expect, test } from "vitest";
import { daysBefore, profileStats, shares } from "./stats.ts";

const today = "2026-11-03";
const work = (...entries: [number, number][]) =>
  entries.map(([ago, tokens]) => ({ day: daysBefore(today, ago), tokens }));

describe("profile stats", () => {
  test("totals, peak and active days count only the year that ends today", () => {
    const stats = profileStats(
      [...work([0, 100], [3, 500], [10, 50]), { day: daysBefore(today, 400), tokens: 9_000 }],
      today,
    );
    expect(stats.total).toBe(650);
    expect(stats.peak).toEqual({ day: daysBefore(today, 3), tokens: 500 });
    expect(stats.activeDays).toBe(3);
  });

  test("the current streak survives a today with no work yet, and breaks on a missed day", () => {
    expect(profileStats(work([1, 5], [2, 5], [3, 5]), today).currentStreak).toBe(3);
    expect(profileStats(work([0, 5], [1, 5], [3, 5]), today).currentStreak).toBe(2);
    expect(profileStats(work([2, 5], [3, 5]), today).currentStreak).toBe(0);
  });

  test("the longest streak is the longest run of days with work", () => {
    const stats = profileStats(work([1, 1], [20, 1], [21, 1], [22, 1], [23, 1], [40, 1]), today);
    expect(stats.longestStreak).toBe(4);
  });

  test("the grid runs Sunday to Saturday and marks days outside the year as gaps", () => {
    const stats = profileStats([], today);
    for (const week of stats.weeks) expect(week).toHaveLength(7);
    const cells = stats.weeks.flat();
    expect(new Date(`${cells[0]?.day}T00:00:00Z`).getUTCDay()).toBe(0);
    expect(cells.filter((cell) => !cell.outside)).toHaveLength(365);
    expect(cells.find((cell) => cell.day === daysBefore(today, -1))?.outside).toBe(true);
  });

  test("busier days get darker levels, and a day with no work stays empty", () => {
    const stats = profileStats(work([1, 10], [2, 20], [3, 30], [4, 40], [5, 1000]), today);
    const level = (ago: number) =>
      stats.weeks.flat().find((cell) => cell.day === daysBefore(today, ago))?.level;
    expect(level(1)).toBe(1);
    expect(level(5)).toBe(4);
    expect(level(6)).toBe(0);
  });

  test("months are labelled in order, each over the week its first day falls in", () => {
    const stats = profileStats([], today);
    const weeks = stats.months.map((month) => month.week);
    expect(weeks).toEqual(weeks.toSorted((a, b) => a - b));
    const november = stats.months.at(-1);
    expect(november?.label).toBe("Nov");
    expect(stats.weeks[november?.week ?? -1]?.some((cell) => cell.day === "2026-11-01")).toBe(true);
    const june = stats.months.find((month) => month.label === "Jun");
    expect(stats.weeks[june?.week ?? -1]?.some((cell) => cell.day === "2026-06-01")).toBe(true);
  });
});

describe("shares", () => {
  test("ranks rows by tokens and gives each a whole percent of the total", () => {
    expect(
      shares(
        [
          { key: "codex", tokens: 25 },
          { key: "claude", tokens: 74 },
          { key: "pi", tokens: 1 },
        ],
        2,
      ),
    ).toEqual([
      { key: "claude", tokens: 74, percent: 74 },
      { key: "codex", tokens: 25, percent: 25 },
    ]);
  });

  test("a tiny share still reads as 1%, and nothing used means no rows", () => {
    expect(
      shares(
        [
          { key: "a", tokens: 1_000 },
          { key: "b", tokens: 1 },
        ],
        5,
      )[1]?.percent,
    ).toBe(1);
    expect(shares([{ key: "a", tokens: 0 }], 5)).toEqual([]);
  });
});
