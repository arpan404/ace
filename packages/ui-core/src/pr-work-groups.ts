import type { ForgePrRow } from "@ace/protocol";
import type { RowGroup } from "./forge-lists.ts";
import { prTone, prWords } from "./forge-marks.ts";
import {
  prStepLabels,
  prStepsForYou,
  type LocalCheckResult,
  type PrNextStep,
} from "./pr-next-step.ts";
import type { LinkedThread } from "./pr-row-steps.ts";

/*
 * The open pull requests by who has the next move: the person, an agent of theirs, someone
 * else, or nobody (ready to merge). Each row says its state in words, in its status tone, and
 * names the action that moves it on. Pure.
 */

export type PrWorkGroup = "you" | "agents" | "wait" | "merge";

const groups: readonly { id: PrWorkGroup; label: string }[] = [
  { id: "you", label: "Needs you" },
  { id: "agents", label: "Agents working" },
  { id: "wait", label: "Waiting on others" },
  { id: "merge", label: "Ready to merge" },
];

/**
 * A row's group. An agent waiting on the person, and a review asked of them, are theirs; while
 * a linked agent is still working, the row is the agent's, never ready to merge.
 */
export function prWorkGroup(step: PrNextStep, thread: LinkedThread | undefined): PrWorkGroup {
  if (step === "answer" || step === "review") return "you";
  if (thread?.working && step !== "none") return "agents";
  if (prStepsForYou.includes(step)) return "you";
  if (step === "merge") return "merge";
  return "wait";
}

const newest = (a: ForgePrRow, b: ForgePrRow) => b.updatedAt.localeCompare(a.updatedAt);

/**
 * Rows in their groups, in the groups' order: Needs you most urgent first (an agent's question,
 * then reviews, conflicts, failures), then newest activity; every other group newest first.
 * Empty groups are left out.
 */
export function groupByWork(
  rows: readonly ForgePrRow[],
  stepOf: (row: ForgePrRow) => PrNextStep,
  threadOf: (row: ForgePrRow) => LinkedThread | undefined,
): RowGroup<ForgePrRow>[] {
  const urgency = (row: ForgePrRow) => prStepsForYou.indexOf(stepOf(row));
  return groups
    .map((group) => {
      const members = rows.filter((row) => prWorkGroup(stepOf(row), threadOf(row)) === group.id);
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

/** A status tone (`data-tone`), or none for plain words in the text colour. */
export type PrStatusTone = "failed" | "needs-you" | "waiting" | "done" | "working" | "idle";

export interface PrStatusWords {
  words: string;
  tone: PrStatusTone | undefined;
}

function waitingOn(row: ForgePrRow): string {
  const people = row.reviewers ?? [];
  const [first] = people;
  if (!first) return "Waiting on review";
  return people.length > 1 ? `Waiting on ${first} +${people.length - 1}` : `Waiting on ${first}`;
}

/** What a waiting row waits on, most telling first. */
function waitingWords(row: ForgePrRow, local: LocalCheckResult): PrStatusWords {
  if (row.state === "draft") return { words: "Draft", tone: "idle" };
  if (row.conflicting) return { words: "Conflicts", tone: "failed" };
  if (row.ci === "failure" || local === "failed")
    return { words: "Checks failing", tone: "failed" };
  if (row.ci === "pending" || local === "running")
    return { words: "Checks running", tone: "working" };
  if (row.reviewDecision === "CHANGES_REQUESTED")
    return { words: "Changes requested", tone: "idle" };
  if (row.reviewDecision === "REVIEW_REQUIRED") return { words: waitingOn(row), tone: "idle" };
  if (row.behind) return { words: `Behind ${row.baseBranch ?? "base"}`, tone: "idle" };
  return { words: "Waiting", tone: "idle" };
}

/** A row's state in words for its right column ("Checks failing", "sam asked you", "Ready to merge"). */
export function prStatusWords(
  row: ForgePrRow,
  step: PrNextStep,
  local: LocalCheckResult,
  thread: LinkedThread | undefined,
): PrStatusWords {
  if (step === "none") return { words: prWords[row.state], tone: prTone[row.state] };
  if (step === "answer") return { words: "Agent needs you", tone: "needs-you" };
  // Why it is the person's: who asked, never the group's own words again.
  if (step === "review") return { words: `${row.author} asked you`, tone: undefined };
  if (thread?.working) return { words: "Agent working", tone: "working" };
  switch (step) {
    case "resolve":
      return { words: `Conflicts with ${row.baseBranch ?? "base"}`, tone: "failed" };
    case "fix":
      return row.ci !== "failure" && local === "failed"
        ? { words: "Local check failing", tone: "failed" }
        : { words: "Checks failing", tone: "failed" };
    case "address":
      return { words: "Changes requested", tone: "needs-you" };
    case "update":
      return { words: `Behind ${row.baseBranch ?? "base"}`, tone: "needs-you" };
    case "merge":
      return { words: "Ready to merge", tone: "done" };
    default:
      return waitingWords(row, local);
  }
}

/**
 * The word for what moves a row on, saying what pressing it does: its step's button (Review,
 * Merge, Update branch), Open thread for an agent's, Mark ready on the viewer's own draft, else
 * View. Never a state word ("Open"), so it can't be read as the row's state.
 */
export function prNextAction(
  row: Pick<ForgePrRow, "state" | "author">,
  step: PrNextStep,
  thread: LinkedThread | undefined,
  viewer: string | undefined,
): string {
  if (step === "answer" || step === "review") return prStepLabels[step] ?? "View";
  if (thread?.working && step !== "none") return "Open thread";
  if (step === "draft" && viewer && row.author.toLowerCase() === viewer.toLowerCase())
    return "Mark ready";
  return prStepLabels[step] ?? "View";
}
