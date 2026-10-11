import { checkBudgets } from "@ace/perf-kit";
import { budgets } from "./budgets.ts";
import { report, type MainThread, type StreamDelivery } from "./measure.ts";

/** Report a complete sample and reject every documented browser timing violation. */
export function reportBrowser(streamed: number, result: MainThread & StreamDelivery): void {
  const limits = budgets.browser;
  // At most 100 ms of batch-boundary jitter; the 5,000 events/s floor stays fixed.
  // Workload failures are resource errors and must never trigger a timing retry.
  const toleranceSeconds = 0.1;
  const complete =
    result.seconds > toleranceSeconds &&
    result.streamedSeconds > 0 &&
    result.streamAgeSeconds <= toleranceSeconds &&
    result.streamedEvents >= limits.eventsPerSecond * (result.seconds - toleranceSeconds);
  const lines = [
    ["events/s streamed", streamed, limits.eventsPerSecond, streamed >= limits.eventsPerSecond],
    [
      `interaction p95 (ms, ${result.interactions} interactions)`,
      result.p95,
      limits.interactionP95Ms,
      result.p95 <= limits.interactionP95Ms,
    ],
    ["interaction p75 (ms)", result.p75, limits.interactionP95Ms, true],
    [
      "longest main-thread task (ms)",
      result.longest,
      limits.longestTaskMs,
      result.longest <= limits.longestTaskMs,
    ],
    [
      `time in long tasks (${result.longCount} tasks)`,
      result.longShare,
      limits.longTaskShare,
      result.longShare <= limits.longTaskShare,
    ],
  ] as const;
  const violations: string[] = [];
  for (const [label, value, limit, ok] of lines)
    if (!report(label, value, limit, ok)) violations.push(`${label}: ${value} (budget ${limit})`);
  checkBudgets(
    complete ? [] : ["Incomplete streaming workload across the interaction window"],
    violations,
  );
}
