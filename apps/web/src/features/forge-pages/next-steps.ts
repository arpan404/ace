import type { ForgePrRow, VerifyRun } from "@ace/protocol";
import {
  localCheckOf,
  prNextStep,
  prStepsForYou,
  type LocalCheckResult,
  type PrNextStep,
} from "@ace/ui-core";
import type { LinkedThread } from "./linked-threads.ts";
import type { RowGroup } from "./pulls-model.ts";

/*
 * The open list by what each PR needs next (ADR 0094): what is the viewer's to do, what is
 * ready to merge, what waits on someone else, and drafts. Pure.
 */

export interface RowStep {
  step: PrNextStep;
  local: LocalCheckResult;
}

/** A row's next step for `viewer`, from its linked thread and its latest local check. */
export function rowStep(
  row: ForgePrRow,
  viewer: string | undefined,
  thread: LinkedThread | undefined,
  runs: readonly VerifyRun[],
): RowStep {
  const local = localCheckOf(
    runs,
    { owner: row.ref.repository.owner, name: row.ref.repository.name, number: row.ref.number },
    row.headSha,
  );
  const step = prNextStep({
    row,
    viewer,
    linked: thread !== undefined,
    linkedNeedsYou: thread?.needsYou === true,
    local,
  });
  return { step, local };
}

const groups = [
  { id: "you", label: "Needs you" },
  { id: "merge", label: "Ready to merge" },
  { id: "wait", label: "Waiting" },
  { id: "drafts", label: "Drafts" },
] as const;
export type StepGroup = (typeof groups)[number]["id"];

function groupOf(step: PrNextStep): StepGroup {
  if (prStepsForYou.includes(step)) return "you";
  if (step === "merge") return "merge";
  if (step === "draft") return "drafts";
  return "wait";
}

const newest = (a: ForgePrRow, b: ForgePrRow) => b.updatedAt.localeCompare(a.updatedAt);

/**
 * Rows grouped by step: Needs you in step order (answer first), then newest activity first;
 * every other group newest first. Empty groups are left out.
 */
export function groupBySteps(
  rows: readonly ForgePrRow[],
  stepOf: (row: ForgePrRow) => PrNextStep,
): RowGroup<ForgePrRow>[] {
  const urgency = (row: ForgePrRow) => prStepsForYou.indexOf(stepOf(row));
  return groups
    .map((group) => {
      const members = rows.filter((row) => groupOf(stepOf(row)) === group.id);
      return {
        id: group.id,
        label: group.label,
        rows: members.toSorted(
          group.id === "you" ? (a, b) => urgency(a) - urgency(b) || newest(a, b) : newest,
        ),
      };
    })
    .filter((group) => group.rows.length > 0);
}

/** The quiet word a row waiting on someone else shows; none when nothing more is known. */
export function waitingWord(row: ForgePrRow, local: LocalCheckResult): string | undefined {
  if (row.ci === "pending" || local === "running") return "Checks running";
  if (row.reviewDecision === "REVIEW_REQUIRED") return "Waiting on review";
  return undefined;
}

/** The request handed to an agent for a step it can take on: what to do, about which PR. */
export function agentRequest(
  step: PrNextStep,
  row: Pick<ForgePrRow, "ref" | "url" | "baseBranch" | "ci">,
  local: LocalCheckResult,
  command: string | null | undefined,
): string | undefined {
  const pr = `PR #${row.ref.number} (${row.url})`;
  const base = row.baseBranch ?? "its base branch";
  switch (step) {
    case "resolve":
      return `${pr} conflicts with ${base}. Merge ${base} into the PR branch, resolve the conflicts keeping both sides' intent, run the checks and push.`;
    case "fix": {
      const failing = [
        ...(row.ci === "failure" ? ["its GitHub checks"] : []),
        ...(local === "failed"
          ? [command ? `the local check \`${command}\`` : "the local check"]
          : []),
      ];
      const what = failing.join(" and ") || "its checks";
      return `${what.charAt(0).toUpperCase()}${what.slice(1)} fail on ${pr}. Read the failures, find the cause and push a fix to the PR branch.`;
    }
    case "address":
      return `Changes were requested on ${pr}. Read the review comments, make the changes, push them and reply on each thread.`;
    default:
      return undefined;
  }
}
