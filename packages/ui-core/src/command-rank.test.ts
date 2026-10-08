import { expect, test } from "vitest";
import { matchRanges, rankCommand, type RankItem } from "./command-rank.ts";

const items: RankItem[] = [
  { label: "New thread on main in ace", command: true },
  { label: "New thread", command: true },
  { label: "New offset", command: true },
  { label: "Settings", command: true },
  { label: "Network settings audit", extra: "relay · perf/net" },
  { label: "Move settings into the daemon", extra: "ace · settings-move" },
  { label: "Theme editor", command: true },
];

function best(query: string, now?: number, list = items): string[] {
  return list
    .flatMap((item) => {
      const score = rankCommand(query, item, now);
      return score === null ? [] : [{ item, score }];
    })
    .toSorted((a, b) => b.score - a.score)
    .map(({ item }) => item.label);
}

test("letters in order find a command, tightest first", () => {
  expect(best("nwthr")[0]).toBe("New thread");
});

test("words match in any order", () => {
  expect(best("thread new")).toEqual(["New thread", "New thread on main in ace"]);
});

test("a command named exactly by the query comes before threads that mention it", () => {
  expect(best("settings")[0]).toBe("Settings");
});

test("a project or branch finds its thread, below label matches", () => {
  expect(best("perf/net")).toEqual(["Network settings audit"]);
  expect(rankCommand("zzz", items[0] as RankItem)).toBeNull();
});

test("something opened in the last day ranks above an equal match", () => {
  const now = 10 * 24 * 60 * 60 * 1000;
  const threads: RankItem[] = [
    { label: "Fix relay retries", openedAt: now - 2 * 24 * 60 * 60 * 1000 },
    { label: "Fix relay timeouts", openedAt: now - 60_000 },
  ];
  expect(best("fix relay", now, threads)[0]).toBe("Fix relay timeouts");
});

test("the matched characters are marked for bolding", () => {
  expect(matchRanges("thr", "New thread")).toEqual([[4, 7]]);
  expect(matchRanges("thread new", "New thread")).toEqual([
    [0, 3],
    [4, 10],
  ]);
  expect(matchRanges("nwthr", "New thread")).toEqual([
    [0, 1],
    [2, 3],
    [4, 7],
  ]);
});
