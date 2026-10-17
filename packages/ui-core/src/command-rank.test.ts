import { expect, test } from "vitest";
import { compareRanked, matchRanges, rankCommand, type RankItem } from "./command-rank.ts";

function best(query: string, list: RankItem[]): string[] {
  return list
    .flatMap((item) => {
      const score = rankCommand(query, item);
      return score === null ? [] : [{ label: item.label, score, at: item.at }];
    })
    .toSorted(compareRanked)
    .map((row) => row.label);
}

test("every word of the query must be found somewhere in the item", () => {
  const items: RankItem[] = [
    { label: "Fix relay retries", fields: ["relay", "fix/retries"] },
    { label: "Fix billing totals", fields: ["billing-api"] },
  ];
  expect(best("fix relay", items)).toEqual(["Fix relay retries"]);
  expect(best("fix zzz", items)).toEqual([]);
});

test("an exact name beats a prefix, which beats a match inside a word", () => {
  const items: RankItem[] = [
    { label: "Rebuild webapp" },
    { label: "Web" },
    { label: "Webhooks retry" },
    { label: "Cobweb cleanup" },
  ];
  expect(best("web", items)).toEqual(["Web", "Webhooks retry", "Rebuild webapp", "Cobweb cleanup"]);
});

test("a word in the title outranks the same word found only in the project or branch", () => {
  const items: RankItem[] = [
    { label: "Tidy imports", fields: ["settings-move"] },
    { label: "Network settings audit", fields: ["relay"] },
  ];
  expect(best("settings", items)).toEqual(["Network settings audit", "Tidy imports"]);
});

test("a thread is found by its project, branch or pull request number", () => {
  const items: RankItem[] = [
    { label: "Backpressure on fan-out", fields: ["relay", "perf/fanout", "#412"] },
    { label: "Invoice PDF", fields: ["billing-api", "main"] },
  ];
  expect(best("perf/fan", items)).toEqual(["Backpressure on fan-out"]);
  expect(best("#412", items)).toEqual(["Backpressure on fan-out"]);
  expect(best("billing invoice", items)).toEqual(["Invoice PDF"]);
});

test("equal matches go to the one used most recently", () => {
  const items: RankItem[] = [
    { label: "Fix relay retries", at: 1_000 },
    { label: "Fix relay timeouts", at: 9_000 },
    { label: "Fix relay logging" },
  ];
  expect(best("fix relay", items)).toEqual([
    "Fix relay timeouts",
    "Fix relay retries",
    "Fix relay logging",
  ]);
});

test("a label that is the whole query comes before longer ones that start with it", () => {
  const items: RankItem[] = [{ label: "New thread on main" }, { label: "New thread" }];
  expect(best("new thread", items)).toEqual(["New thread", "New thread on main"]);
});

test("the matched words are marked for bolding", () => {
  expect(matchRanges("thr", "New thread")).toEqual([[4, 7]]);
  expect(matchRanges("thread new", "New thread")).toEqual([
    [0, 3],
    [4, 10],
  ]);
  expect(matchRanges("eb", "Cobweb")).toEqual([[4, 6]]);
  expect(matchRanges("zzz", "New thread")).toEqual([]);
});
