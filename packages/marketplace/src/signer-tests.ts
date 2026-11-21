import type { MarketScanReport } from "@ace/protocol/marketplace";
import type { ArchiveFile } from "./archive.ts";
import type { Inspection } from "./checks/index.ts";

/*
 * A bot package's own tests, run by the signer before it signs (ADR 0200 §8, §9): the scenarios
 * in its `tests`, offline on Spade's real engine with spade-testkit's scripted model, as `ace bot
 * test` runs them. The signer runs on a maintainer's machine, where Spade's program is; the Worker
 * can't run it, and a publisher's own word that its tests passed proves nothing. A version whose
 * tests fail is refused for good, with each failure in the report the publisher reads; one whose
 * tests can't run here waits for a signer that can. Pure, but for the runner passed in.
 */

/** What running a package's scenarios found. */
export interface BotTestOutcome {
  /** Every scenario ran and passed. */
  passed: boolean;
  /** How many scenarios ran. */
  scenarios: number;
  /** Each failure, at the file it is in. */
  failures: { path?: string | undefined; message: string }[];
}

/**
 * Runs a bot package's scenarios from its files; throws when they couldn't run at all (Spade's
 * program missing or broken), which is never a failure of the package.
 */
export type BotTestRunner = (files: readonly ArchiveFile[]) => Promise<BotTestOutcome>;

/** Whether a version is a bot package with tests the signer must run before signing. */
export function hasBotTests(inspection: Inspection | undefined): boolean {
  return (
    inspection?.type === "spade-bot" &&
    inspection.recipe.version === 3 &&
    (inspection.recipe.tests?.length ?? 0) > 0
  );
}

const sentence = (failure: BotTestOutcome["failures"][number]) =>
  `${failure.path ? `${failure.path}: ` : ""}${failure.message}`;

/** Why a version whose tests failed isn't signed, in the publisher's words. */
export function testsReason(outcome: BotTestOutcome): string {
  const first = outcome.failures[0];
  const more = outcome.failures.length - 1;
  const why = first ? sentence(first) : "a scenario failed";
  return `Its tests failed when ace's market ran them: ${why}${more > 0 ? ` (and ${more} more)` : ""}`.slice(
    0,
    500,
  );
}

/**
 * The report a refusal for failed tests stores: the scan's own findings and checks, with each
 * failure as a blocking finding of the recipe check, so the publisher's page lists them.
 */
export function failedTestsReport(
  scan: MarketScanReport,
  outcome: BotTestOutcome,
): MarketScanReport {
  const failures = outcome.failures.length
    ? outcome.failures
    : [{ message: "A scenario failed without saying why." }];
  const findings = [
    ...failures.map((failure) => ({
      check: "recipe" as const,
      rule: "tests-failed",
      level: "block" as const,
      ...(failure.path ? { path: failure.path.slice(0, 512) } : {}),
      message: failure.message.slice(0, 500) || "A scenario failed.",
    })),
    ...scan.findings,
  ].slice(0, 500);
  const recipe = {
    id: "recipe" as const,
    verdict: "block" as const,
    sentence: "Its own tests failed on ace's market.",
    findings: failures.length,
  };
  const others = scan.checks.filter((check) => check.id !== "recipe");
  return {
    ...scan,
    verdict: "block",
    checks: [recipe, ...others].slice(0, 16),
    findings,
    truncated: scan.truncated || scan.findings.length + failures.length > 500,
  };
}
