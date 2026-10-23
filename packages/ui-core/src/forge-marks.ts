import type { ForgePrRow } from "@ace/protocol";
import type { LocalCheckResult } from "./pr-next-step.ts";

/*
 * GitHub's marks for a pull request or issue, in ace's status hues: open green, draft grey,
 * merged violet, closed red; issues open green, completed violet. Each carries its word, never
 * colour alone. The tones are the shared status keys every client colours.
 */

export type PrState = "open" | "draft" | "merged" | "closed";
export type IssueState = "open" | "closed";
export type ForgeMarkTone = "done" | "failed" | "working" | "waiting" | "idle";

export interface ForgeMark {
  word: string;
  tone: ForgeMarkTone;
}

export const prTone = { open: "done", draft: "idle", merged: "waiting", closed: "failed" } as const;
export const prWords = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
} as const;

export function issueStateMark(state: IssueState): ForgeMark {
  return state === "open" ? { word: "Open", tone: "done" } : { word: "Closed", tone: "waiting" };
}

/** GitHub's review decision as a word and tone; none when the repository requires no review. */
export function reviewMark(decision: ForgePrRow["reviewDecision"]): ForgeMark | undefined {
  if (decision === "APPROVED") return { word: "Approved", tone: "done" };
  if (decision === "CHANGES_REQUESTED") return { word: "Changes requested", tone: "failed" };
  if (decision === "REVIEW_REQUIRED") return { word: "Review required", tone: "idle" };
  return undefined;
}

/** GitHub's checks and the latest local check of the head, as one state. */
export function checksState(
  ci: ForgePrRow["ci"],
  local: LocalCheckResult,
): "failure" | "pending" | "success" | undefined {
  if (ci === "failure" || local === "failed") return "failure";
  if (ci === "pending" || local === "running") return "pending";
  if (ci === "success" || local === "passed") return "success";
  return undefined;
}

const localWords = {
  failed: "local check failed",
  running: "local check running",
  passed: "local check passed",
};

/** The checks as one word and tone ("Checks failing, local check failed"); none when unknown. */
export function checksMark(ci: ForgePrRow["ci"], local: LocalCheckResult): ForgeMark | undefined {
  const state = checksState(ci, local);
  const mark: ForgeMark | undefined =
    state === "success"
      ? { word: "Checks passed", tone: "done" }
      : state === "failure"
        ? { word: "Checks failing", tone: "failed" }
        : state === "pending"
          ? { word: "Checks running", tone: "working" }
          : undefined;
  if (!mark) return undefined;
  return local ? { ...mark, word: `${mark.word}, ${localWords[local]}` } : mark;
}
