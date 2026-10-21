import { modelDisplayName } from "@ace/models/display-name";
import type { ProviderKind, ThreadRunMetadata, ThreadStatus } from "@ace/protocol";
import type {
  OffshiftCardCriterion,
  OffshiftEvidenceKind,
  OffshiftEvidenceState,
  OffshiftPhase,
  OffshiftRunCard,
  OffshiftStepState,
} from "@ace/protocol/offshift";
import { offshiftPhaseNames, offshiftPlaybookNames, runMark } from "@ace/projection/offshift-mark";
import { listTreeFacts, treeWorking } from "./live-status.ts";
import { providerNames } from "./providers.ts";
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

/**
 * A required kind still without a current pass: "UI", or "Independent UI" when the pass must
 * come from another provider or model than the owner's. Failed when its latest check failed.
 */
export interface OffshiftNeedRow {
  kind: string;
  failed: boolean;
}
export interface OffshiftCriterionRow {
  id: string;
  description: string;
  /** Met: every required kind has a current pass. Failed: one kind's check failed. */
  state: "Met" | "Failed" | "Open";
  needs: OffshiftNeedRow[];
  /** Each required kind's standing and who recorded it, one per line: "UI check · Passed · Codex". */
  detail: string;
}
/** One step of the current phase: its title, state word and, when skipped, the reason. */
export interface OffshiftStepRow {
  id: string;
  title: string;
  state: "Done" | "Skipped" | "To do";
  reason: string | undefined;
}
export interface OffshiftSummary {
  word: OffshiftWord;
  tone: Tone;
  /** "Fix · Verify · 3 of 5"; the playbook leads when the run started from one. */
  phase: string;
  blocker: string | undefined;
  outcome: string;
  criteria: OffshiftCriterionRow[];
  /** Criteria beyond the card's list. */
  moreCriteria: number;
  /** The current phase's steps, in order. */
  steps: OffshiftStepRow[];
  done: boolean;
}

const phases: readonly OffshiftPhase[] = ["plan", "implement", "verify", "review", "delivery"];
const kindNames: Record<OffshiftEvidenceKind, string> = {
  automated: "Automated check",
  source: "Source review",
  ui: "UI check",
  human: "Human review",
  manual: "Manual check",
};
/** A kind in a criterion row, where room is short. */
const shortKindNames: Record<OffshiftEvidenceKind, string> = {
  automated: "Automated",
  source: "Source review",
  ui: "UI",
  human: "Human review",
  manual: "Manual",
};
const stateNames: Record<OffshiftEvidenceState, string> = {
  pass: "Passed",
  fail: "Failed",
  stale: "Out of date",
  missing: "Not checked",
  not_independent: "Not independent",
};
const stepStateNames: Record<OffshiftStepState, OffshiftStepRow["state"]> = {
  todo: "To do",
  done: "Done",
  skipped: "Skipped",
};
/** A provider and model in words, no ids: "Claude Code · Opus 4.5". */
function who(provider: ProviderKind | undefined, model: string | null | undefined): string {
  return [provider && providerNames[provider], model && modelDisplayName(model).displayName]
    .filter(Boolean)
    .join(" · ");
}

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
  // In delivery the card's steps are delivery's: one still to do (the report) is unfinished.
  const unfinished = runMark(card).state !== "delivered";
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
  return {
    ...state,
    phase: [
      card.playbook && offshiftPlaybookNames[card.playbook],
      offshiftPhaseNames[card.phase],
      `${phases.indexOf(card.phase) + 1} of ${phases.length}`,
    ]
      .filter(Boolean)
      .join(" · "),
    blocker: card.blocker ?? undefined,
    outcome: card.outcome,
    criteria: card.criteria.map(criterionRow),
    moreCriteria: card.criteriaCount - card.criteria.length,
    steps: card.steps.map((step) => ({
      id: step.id,
      title: step.title,
      state: stepStateNames[step.state],
      reason: step.reason,
    })),
    done: state.word === "Done",
  };
}

/** One criterion: whether it holds, the kinds it still needs, and each kind's standing. */
function criterionRow(item: OffshiftCardCriterion): OffshiftCriterionRow {
  const open = item.evidence.filter((evidence) => evidence.state !== "pass");
  return {
    id: item.id,
    description: item.description,
    state: open.length === 0 ? "Met" : open.some(failed) ? "Failed" : "Open",
    needs: open.map((evidence) => ({
      kind: item.independent
        ? `Independent ${shortKindNames[evidence.kind]}`
        : shortKindNames[evidence.kind],
      failed: failed(evidence),
    })),
    detail: item.evidence
      .map((evidence) =>
        [
          kindNames[evidence.kind],
          stateNames[evidence.state],
          evidence.by && who(evidence.by.provider, evidence.by.model),
        ]
          .filter(Boolean)
          .join(" · "),
      )
      .join("\n"),
  };
}

function failed(evidence: { state: OffshiftEvidenceState }): boolean {
  return evidence.state === "fail";
}
