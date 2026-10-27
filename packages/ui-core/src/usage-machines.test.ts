import { AccountSummary } from "@ace/protocol/accounts";
import type { UsageRow } from "@ace/protocol";
import { expect, test } from "vitest";
import { accountView } from "./accounts.ts";
import { usageLimits } from "./usage-limits.ts";
import { usageAccounts, usageCoverage } from "./usage-machines.ts";
import { usageReport, type EnvironmentUsage } from "./usage-report.ts";

const now = 50_000_000;
const hour = 3_600_000;

const totals = (tokens: number) => ({
  inputTokens: tokens,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  providerReportedUsd: 0,
  estimatedUsd: 0,
  equivalentApiUsd: tokens / 1000,
  overflow: false,
  unpricedTokens: 0,
  subscriptionTokens: tokens,
  unknownBillingTokens: 0,
});
const row = (dimensions: UsageRow["dimensions"], tokens: number): UsageRow => ({
  dimensions,
  totals: totals(tokens),
});
const machine = (day: string, tokens: number, threads: string[]): EnvironmentUsage => ({
  daily: [row({ day, provider: "codex" }, tokens)],
  models: [row({ model: "gpt-5", provider: "codex" }, tokens)],
  threads: threads.map((thread) => row({ thread, provider: "codex" }, tokens / threads.length)),
  threadsTruncated: false,
});

test("two machines' usage sums per day, and each machine's sessions count as its own", () => {
  const report = usageReport(
    [machine("2026-10-02", 1000, ["a", "b"]), machine("2026-10-02", 3000, ["b", "c"])],
    ["2026-10-01", "2026-10-02"],
  );
  expect(report.tokens).toBe(4000);
  expect(report.usd).toBe(4);
  expect(report.days.map((day) => day.tokens)).toEqual([0, 4000]);
  // A thread continued on another machine gets a new id there, so the same id on two
  // machines is two sessions, never one.
  expect(report.sessions).toBe(4);
  expect(report.providers[0]?.sessions).toBe(4);
});

test("an offline machine is named in the coverage line, never left out silently", () => {
  const coverage = usageCoverage([
    { id: "mac", name: "Mac", reach: "counted" },
    { id: "studio", name: "Studio", reach: "offline" },
    { id: "mini", name: "Mini", reach: "counted" },
  ]);
  expect(coverage.complete).toBe(false);
  expect(coverage.line).toBe("2 of 3 machines · Studio is offline");
  expect(coverage.missing.map((entry) => entry.id)).toEqual(["studio"]);
});

test("coverage says each reason a machine is missing, and stays quiet for one counted machine", () => {
  expect(
    usageCoverage([
      { id: "mac", name: "Mac", reach: "counted" },
      { id: "studio", name: "Studio", reach: "failed" },
      { id: "mini", name: "Mini", reach: "offline" },
      { id: "air", name: "Air", reach: "offline" },
    ]).line,
  ).toBe("1 of 4 machines · Mini and Air are offline · Studio couldn't be read");
  expect(usageCoverage([{ id: "mac", name: "Mac", reach: "counted" }]).line).toBeNull();
  expect(usageCoverage([{ id: "mac", name: "Mac", reach: "offline" }]).line).toBe("Mac is offline");
  expect(
    usageCoverage([
      { id: "mac", name: "Mac", reach: "counted" },
      { id: "studio", name: "Studio", reach: "counted" },
    ]).line,
  ).toBe("All 2 machines");
});

const account = (id: string, signedInAs: string | undefined, usedPercent: number, at: number) =>
  accountView(
    AccountSummary.parse({
      id,
      provider: "codex",
      label: "Personal",
      ...(signedInAs ? { signedInAs } : {}),
      availability: "available",
      quota: {
        auth: "logged_in",
        observedAt: at,
        windows: { primary: { usedPercent, resetsAt: now + hour, windowDurationMins: 300 } },
        usage: {},
      },
    }),
  );

test("one login signed in on two machines is listed once, with the fresher reading and both names", () => {
  const limits = usageLimits(
    usageAccounts([
      { id: "mac", name: "Mac", accounts: [account("codex-1", "Me@Example.com", 40, now - hour)] },
      { id: "studio", name: "Studio", accounts: [account("codex-9", "me@example.com", 70, now)] },
    ]),
    now,
  );
  const accounts = limits.providers[0]?.accounts ?? [];
  expect(accounts).toHaveLength(1);
  expect(accounts[0]?.environment).toBe("Mac and Studio");
  expect(accounts[0]?.windows[0]?.leftPercent).toBe(30);
  // A banked reset goes through the machine whose reading is shown.
  expect(accounts[0]?.environmentId).toBe("studio");
  expect(limits.unsure).toEqual([]);
});

test("accounts ace can't identify stay one per machine, and the page says it can't tell", () => {
  const limits = usageLimits(
    usageAccounts([
      { id: "mac", name: "Mac", accounts: [account("codex-1", undefined, 40, now)] },
      { id: "studio", name: "Studio", accounts: [account("codex-1", undefined, 40, now)] },
    ]),
    now,
  );
  expect(limits.providers[0]?.accounts.map((entry) => entry.environment)).toEqual([
    "Mac",
    "Studio",
  ]);
  expect(limits.unsure).toEqual([
    "Can't tell whether the Codex accounts on Mac and Studio are the same; each is listed.",
  ]);
});

test("two different logins on two machines are both listed, each under its machine", () => {
  const limits = usageLimits(
    usageAccounts([
      { id: "mac", name: "Mac", accounts: [account("codex-1", "me@example.com", 40, now)] },
      { id: "studio", name: "Studio", accounts: [account("codex-1", "work@example.com", 10, now)] },
    ]),
    now,
  );
  expect(limits.providers[0]?.accounts.map((entry) => entry.environment)).toEqual([
    "Mac",
    "Studio",
  ]);
  expect(limits.unsure).toEqual([]);
});
