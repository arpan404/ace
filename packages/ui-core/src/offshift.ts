import type { ThreadRunMetadata, ThreadStatus } from "@ace/protocol";
import type {
  OffshiftEvidenceKind,
  OffshiftEvidenceState,
  OffshiftPhase,
  OffshiftRunCard,
} from "@ace/protocol/offshift";
import { listTreeFacts, treeWorking } from "./live-status.ts";
import type { Tone } from "./status.ts";

/*
 * What the person sees of a thread's Offshift run. The card is what the run recorded at its
 * last write; whether it is done also depends on the whole agent tree, which the card cannot
 * know (the agent writes it mid-turn). So Done shows only when the run is delivered with every
 * piece of evidence current and nothing in the tree still works or waits. Pure.
 */

/** The fixed status vocabulary (DESIGN.md §6). */
export type OffshiftWord = "Working" | "Approve" | "Answer" | "Failed" | "Done" | "Waiting";

/** The agent tree around the run: the thread's status and live hints, and its loaded agents. */
export interface OffshiftTree {
  status: ThreadStatus;
  live?: ThreadRunMetadata | undefined;
  /** Loaded agents still starting, working or waiting on their own. */
  runningAgents: number;
  /** A loaded request waits on the person: an approval, or another question. */
  request?: "approval" | "question" | undefined;
}

export interface OffshiftEvidenceRow {
  kind: string;
  state: string;
  /** Status hue for a current pass or failure; none while out of date or not checked. */
  tone: Tone | undefined;
}
export interface OffshiftCriterionRow {
  id: string;
  description: string;
  evidence: OffshiftEvidenceRow[];
}
export interface OffshiftSummary {
  word: OffshiftWord;
  tone: Tone;
  /** "Verify · 3 of 5". */
  phase: string;
  blocker: string | undefined;
  /** Evidence still missing, failing or out of date: "Bad password shows an error", "UI check". */
  missing: { key: string; description: string; kind: string }[];
  /** Missing evidence beyond the card's list. */
  moreMissing: number;
  outcome: string;
  criteria: OffshiftCriterionRow[];
  /** Criteria beyond the card's list. */
  moreCriteria: number;
  done: boolean;
}

const phases: readonly OffshiftPhase[] = ["plan", "implement", "verify", "review", "delivery"];
const phaseNames: Record<OffshiftPhase, string> = {
  plan: "Plan",
  implement: "Implement",
  verify: "Verify",
  review: "Review",
  delivery: "Delivery",
};
const kindNames: Record<OffshiftEvidenceKind, string> = {
  automated: "Automated check",
  source: "Source review",
  ui: "UI check",
  human: "Human review",
  manual: "Manual check",
};
const stateNames: Record<OffshiftEvidenceState, string> = {
  pass: "Passed",
  fail: "Failed",
  stale: "Out of date",
  missing: "Not checked",
};

/**
 * The tree's own state in the fixed vocabulary, or undefined when it is done: nothing works,
 * waits on the person, runs in the background or is held.
 */
function treeState(tree: OffshiftTree): { word: OffshiftWord; tone: Tone } | undefined {
  const facts = listTreeFacts(tree);
  const asking = tree.live?.asking?.[0]?.kind ?? tree.request;
  if (facts.needsYou || tree.request)
    return { word: asking === "approval" ? "Approve" : "Answer", tone: "needs-you" };
  if (tree.status.state === "failed" || tree.status.state === "unresponsive")
    return { word: "Failed", tone: "failed" };
  if (treeWorking(facts) || tree.runningAgents > 0) return { word: "Working", tone: "working" };
  if (tree.status.state === "done" || tree.status.state === "new") return undefined;
  return { word: "Waiting", tone: "waiting" };
}

/** What the Summary shows of `card`, gated on the whole tree. */
export function offshiftSummary(card: OffshiftRunCard, tree: OffshiftTree): OffshiftSummary {
  const live = treeState(tree);
  const unfinished = card.phase !== "delivery" || card.pendingCount > 0;
  // A request to the person or a failure speaks first, blocker or not: that is what they act
  // on. Otherwise a blocker holds the run; then a live tree speaks for itself; a settled tree
  // with an unfinished run waits on whoever picks it up.
  const urgent = live?.tone === "needs-you" || live?.tone === "failed";
  const state = urgent
    ? live
    : card.blocker
      ? { word: "Waiting" as const, tone: "waiting" as const }
      : (live ??
        (unfinished
          ? { word: "Waiting" as const, tone: "waiting" as const }
          : { word: "Done" as const, tone: "done" as const }));
  const descriptions = new Map(card.criteria.map((item) => [item.id, item.description]));
  return {
    ...state,
    phase: `${phaseNames[card.phase]} · ${phases.indexOf(card.phase) + 1} of ${phases.length}`,
    blocker: card.blocker ?? undefined,
    missing: card.pending.map((item) => ({
      key: `${item.criterionId}:${item.kind}`,
      description: descriptions.get(item.criterionId) ?? item.criterionId,
      kind: kindNames[item.kind],
    })),
    moreMissing: card.pendingCount - card.pending.length,
    outcome: card.outcome,
    criteria: card.criteria.map((item) => ({
      id: item.id,
      description: item.description,
      evidence: item.evidence.map((evidence) => ({
        kind: kindNames[evidence.kind],
        state: stateNames[evidence.state],
        tone: evidence.state === "pass" ? "done" : evidence.state === "fail" ? "failed" : undefined,
      })),
    })),
    moreCriteria: card.criteriaCount - card.criteria.length,
    done: state.word === "Done",
  };
}
