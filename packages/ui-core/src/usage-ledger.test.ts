import type { UsageRow } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  ledgerChange,
  ledgerLines,
  ledgerScope,
  machineLedgerLines,
  type LedgerStep,
} from "./usage-ledger.ts";

/** A row of `tokens` (all input), worth `usd` at API prices. */
const row = (dimensions: UsageRow["dimensions"], tokens: number, usd: number): UsageRow => ({
  dimensions,
  totals: {
    inputTokens: tokens,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    providerReportedUsd: 0,
    estimatedUsd: 0,
    equivalentApiUsd: usd,
    overflow: false,
    unpricedTokens: usd === 0 ? tokens : 0,
    subscriptionTokens: tokens,
    unknownBillingTokens: 0,
  },
});

const days = ["2026-11-09", "2026-11-10", "2026-11-11"];

test("rows from every machine add up by value, most cost first, with their change", () => {
  const mac = {
    totals: [row({ provider: "claude" }, 1000, 30), row({ provider: "codex" }, 4000, 10)],
    previous: [row({ provider: "claude" }, 1000, 20)],
    series: [],
  };
  const mini = { totals: [row({ provider: "claude" }, 500, 10)], previous: [], series: [] };
  const lines = ledgerLines([mac, mini], "provider", days);
  expect(lines.map((line) => [line.key, line.usd, line.tokens])).toEqual([
    ["claude", 40, 1500],
    ["codex", 10, 4000],
  ]);
  expect(ledgerChange(lines[0]!, "cost").label).toBe("+100%");
  expect(ledgerChange(lines[1]!, "cost").direction).toBe("new");
});

test("a row's days line up with the span, zero on days it didn't run", () => {
  const read = {
    totals: [row({ workspace: "w1" }, 300, 3)],
    previous: [],
    series: [
      row({ day: "2026-11-09", workspace: "w1" }, 100, 1),
      row({ day: "2026-11-11", workspace: "w1" }, 200, 2),
    ],
  };
  const [line] = ledgerLines([read], "workspace", days);
  expect(line?.days.map((day) => day.usd)).toEqual([1, 0, 2]);
});

test("use recorded before a dimension existed, and values with no tokens, stay out", () => {
  const read = {
    totals: [
      row({ skill: null }, 900, 9),
      row({ skill: "review" }, 0, 0),
      row({ skill: "ship" }, 5, 1),
    ],
    previous: [],
    series: [],
  };
  expect(ledgerLines([read], "skill", days).map((line) => line.key)).toEqual(["ship"]);
});

test("machines are one line each, from their own reads", () => {
  const lines = machineLedgerLines(
    [
      { key: "mini", read: { totals: [row({}, 100, 1)], previous: [], series: [] } },
      { key: "mac", read: { totals: [row({}, 100, 5)], previous: [row({}, 100, 5)], series: [] } },
    ],
    days,
  );
  expect(lines.map((line) => [line.key, line.usd])).toEqual([
    ["mac", 5],
    ["mini", 1],
  ]);
  expect(ledgerChange(lines[0]!, "tokens").label).toBe("No change");
});

test("an opened row narrows its parts' queries to every step above it", () => {
  const steps: LedgerStep[] = [
    { group: "provider", key: "claude", label: "Claude" },
    { group: "account", key: "acct-work", label: "Work" },
  ];
  expect(ledgerScope(steps)).toEqual({
    filters: { provider: ["claude"], account: ["acct-work"] },
    machine: undefined,
  });
});

test("a machine step keeps its parts to that machine instead of filtering a query", () => {
  const steps: LedgerStep[] = [{ group: "machine", key: "mini", label: "Mac mini" }];
  expect(ledgerScope(steps)).toEqual({ filters: {}, machine: "mini" });
});
