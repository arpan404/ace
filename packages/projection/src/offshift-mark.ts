import type {
  OffshiftPhase,
  OffshiftRunCard,
  OffshiftRunMark,
  OffshiftPlaybookId,
} from "@ace/protocol/offshift";
import type { ThreadStatus } from "@ace/protocol/thread-status";

/*
 * A run's card reduced to what a list row and a notification need. The card is what the run
 * recorded at its last write, mid-turn; only the whole tree's status can say it has settled.
 * Pure.
 */

export const offshiftPhaseNames: Record<OffshiftPhase, string> = {
  plan: "Plan",
  implement: "Implement",
  verify: "Verify",
  review: "Review",
  delivery: "Delivery",
};
export const offshiftPlaybookNames: Record<OffshiftPlaybookId, string> = {
  fix: "Fix",
  feature: "Feature",
  refactor: "Refactor",
  perf: "Performance",
  investigate: "Investigate",
  ui: "UI",
  land: "Land",
};

/**
 * Where the run stands: blocked while a blocker is recorded; delivered in delivery with no
 * evidence pending and no delivery step to do; open otherwise.
 */
export function runMark(card: OffshiftRunCard): OffshiftRunMark {
  const delivered =
    card.phase === "delivery" &&
    card.pendingCount === 0 &&
    !card.steps.some((step) => step.state === "todo");
  return {
    phase: card.phase,
    state: card.blocker ? "blocked" : delivered ? "delivered" : "open",
    pendingCount: card.pendingCount,
    ...(card.playbook ? { playbook: card.playbook } : {}),
  };
}

export interface RunNotice {
  outcome: "stopped" | "blocked" | "delivered";
  phase: OffshiftPhase;
  /** "Run stopped at Verify", "Run blocked at Review", "Run delivered". */
  headline: string;
}

/**
 * What a settled tree's notice says about its latest run, or nothing. Only a done tree has
 * settled: while anything works, waits on the person or is held, the run says nothing, so a
 * delivered run never reads as delivered under a live tree and a blocker recorded mid-turn
 * stays with the agent (it asks the person itself).
 */
export function runNotice(
  mark: OffshiftRunMark,
  tree: ThreadStatus["state"],
): RunNotice | undefined {
  if (tree !== "done") return undefined;
  const phase = offshiftPhaseNames[mark.phase];
  if (mark.state === "blocked")
    return { outcome: "blocked", phase: mark.phase, headline: `Run blocked at ${phase}` };
  if (mark.state === "open")
    return { outcome: "stopped", phase: mark.phase, headline: `Run stopped at ${phase}` };
  return { outcome: "delivered", phase: mark.phase, headline: "Run delivered" };
}
