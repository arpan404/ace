import { expect, test } from "vitest";
import {
  budgetFailures,
  budgetTable,
  failsOnFastBudget,
  overBudget,
  parseRunArgs,
  projectsFor,
} from "./test-tiers.ts";

const allowlist = {
  fast: { "apps/web/src/slow.test.tsx": "TODO cleanup" },
  process: { "apps/daemon/src/slow.process.test.ts": "TODO cleanup" },
};

test("a fast-tier file over 5s fails the run unless it is allowlisted", () => {
  const findings = overBudget(
    [
      { file: "apps/web/src/slow.test.tsx", project: "web", ownMs: 9_000 },
      { file: "packages/git/src/new.test.ts", project: "unit", ownMs: 6_000 },
      { file: "packages/git/src/quick.test.ts", project: "unit", ownMs: 4_900 },
    ],
    allowlist,
  );
  expect(budgetFailures(findings).map((finding) => finding.file)).toEqual([
    "packages/git/src/new.test.ts",
  ]);
  expect(budgetTable(findings)).toContain("packages/git/src/new.test.ts");
  expect(budgetTable(findings)).not.toContain("slow.test.tsx");
  expect(failsOnFastBudget("fast")).toBe(true);
  expect(failsOnFastBudget("changed")).toBe(true);
  expect(failsOnFastBudget("full")).toBe(false);
});

test("process files are flagged over 30s but never fail the run; slow-tier files have no budget", () => {
  const findings = overBudget(
    [
      { file: "apps/daemon/src/new.process.test.ts", project: "process", ownMs: 31_000 },
      { file: "apps/daemon/src/ok.process.test.ts", project: "process", ownMs: 29_000 },
      { file: "tools/release/src/archive.process.test.ts", project: "slow-process", ownMs: 90_000 },
    ],
    allowlist,
  );
  expect(findings.map((finding) => finding.file)).toEqual(["apps/daemon/src/new.process.test.ts"]);
  expect(budgetFailures(findings)).toEqual([]);
});

test("a budget scale loosens every budget for slower machines", () => {
  const timings = [{ file: "packages/git/src/new.test.ts", project: "unit", ownMs: 8_000 }];
  expect(overBudget(timings, allowlist, 2)).toEqual([]);
  expect(overBudget(timings, allowlist, 1)).toHaveLength(1);
});

test("affected-only runs cover the fast tier unless asked to include process or slow tests", () => {
  const fast = projectsFor(parseRunArgs(["changed"]));
  expect(fast).toEqual(["unit", "web", "client-react"]);
  expect(projectsFor(parseRunArgs(["changed", "--with-process"]))).toEqual([...fast, "process"]);
  expect(projectsFor(parseRunArgs(["changed", "--with-slow"]))).toContain("browser-process");
  expect(projectsFor(parseRunArgs(["full"]))).toEqual([]);
});

test("runner arguments pass through to Vitest without the npm-style separator", () => {
  const options = parseRunArgs(["changed", "--base", "abc123", "--", "packages/git", "-t", "x"]);
  expect(options.base).toBe("abc123");
  expect(options.vitestArgs).toEqual(["packages/git", "-t", "x"]);
  expect(parseRunArgs(["fast", "--with-process"]).vitestArgs).toEqual(["--with-process"]);
  expect(() => parseRunArgs(["everything"])).toThrow();
});
