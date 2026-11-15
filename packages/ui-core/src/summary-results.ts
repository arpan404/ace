import type { ForgePrStatus, LinkedPullRequest, TodoEntry, TurnDigest } from "@ace/protocol";
import { checkLabels, type CheckOutcome, type CheckRun } from "./check-runs.ts";
import { pluralCount } from "./counts.ts";

/*
 * The Summary's Results and Plan in words, shared by the web's Summary tab and the phone's:
 * each pull request's line, how checks went, how many files changed and which commands failed
 * outside a check. Pure.
 */

export const prStateWords: Record<LinkedPullRequest["state"], string> = {
  open: "In review",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

export const prChecksWords: Record<ForgePrStatus["ci"], string> = {
  none: "No checks",
  pending: "Checks running",
  success: "Checks passed",
  failure: "Checks failed",
  unknown: "",
};

/** The checks roll-up the thread's link carries, as the forge's own checks state. */
export function linkedChecks(
  pr: Pick<LinkedPullRequest, "checks">,
): ForgePrStatus["ci"] | undefined {
  switch (pr.checks) {
    case "pending":
      return "pending";
    case "passed":
      return "success";
    case "failed":
      return "failure";
    default:
      return undefined;
  }
}

/** "#12 · In review · Checks passed": number, state and, once known, its checks. */
export function summaryPrLine(
  pr: Pick<LinkedPullRequest, "number" | "state">,
  ci?: ForgePrStatus["ci"] | undefined,
): string {
  return [`#${pr.number}`, prStateWords[pr.state], ci ? prChecksWords[ci] : ""]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The pull requests a Summary lists, in review first: closed ones fold into one line that opens
 * them (`fold`), and once open the same line hides them again. No fold without closed ones.
 */
export function summaryPrRows<T extends Pick<LinkedPullRequest, "state">>(
  prs: readonly T[],
  showClosed: boolean,
): { rows: T[]; fold: string | undefined } {
  const current = prs.filter((pr) => pr.state !== "closed");
  const closed = prs.filter((pr) => pr.state === "closed");
  if (!closed.length) return { rows: current, fold: undefined };
  return showClosed
    ? { rows: [...current, ...closed], fold: "Hide closed pull requests" }
    : { rows: current, fold: `${pluralCount(closed.length, "earlier pull request")}, closed` };
}

const outcomeWords: Record<CheckOutcome, string> = {
  passed: "passed",
  failed: "failed",
  running: "running",
  ran: "ran",
};

/** One check in words: "Tests passed", "Typecheck failed · exit 2". */
export function checkWords(check: Pick<CheckRun, "kind" | "exitCode">, outcome: CheckOutcome) {
  const exit =
    outcome === "failed" && typeof check.exitCode === "number" ? ` · exit ${check.exitCode}` : "";
  return `${checkLabels[check.kind]} ${outcomeWords[outcome]}${exit}`;
}

/** "3 files", or "64+ files" once the digest stopped counting them. */
export function changedFilesCount(digest: Pick<TurnDigest, "files" | "truncated">): string {
  return digest.truncated && digest.files.length >= 64
    ? "64+ files"
    : pluralCount(digest.files.length, "file");
}

/** "3 files changed". */
export const filesChangedWords = (digest: Pick<TurnDigest, "files" | "truncated">) =>
  `${changedFilesCount(digest)} changed`;

/** Commands that failed besides the checks already said to have failed. */
export function otherCommandFailures(
  digest: Pick<TurnDigest, "commandsFailed"> | undefined,
  checks: readonly Pick<CheckRun, "failed">[],
): number {
  const failedChecks = checks.filter((check) => check.failed).length;
  return Math.max(0, (digest?.commandsFailed ?? 0) - failedChecks);
}

/** A to-do's status in words, for those who can't see its box. */
export function todoStatusWords(status: TodoEntry["status"]): string {
  switch (status) {
    case "completed":
      return "done";
    case "in_progress":
      return "in progress";
    case "cancelled":
      return "cancelled";
    default:
      return "to do";
  }
}
