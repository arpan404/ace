import type { ForgeHostedPendingReview, ForgeReviewDraft } from "@ace/protocol";
import { hunkRows, type HunkRow } from "@ace/forge/review-hunk";
import { lockedText } from "./forge-review-rules.ts";

/*
 * Why a review can't be submitted yet, in words, and what a push did to its drafts. The web's
 * PR page and the phone share these. Pure.
 */

/** Where a pending draft stands against the PR's head. */
export type DraftStanding = "current" | "moving" | "outdated";

/** Current at the head; moving while a move to it hasn't been tried; outdated when it failed. */
export function draftStanding(draft: ForgeReviewDraft, headSha: string): DraftStanding {
  if (draft.anchor.commit === headSha) return "current";
  return draft.outdated?.headSha === headSha ? "outdated" : "moving";
}

const comments = (n: number) => (n === 1 ? "1 comment" : `${n} comments`);

/**
 * Why Submit review is off, or undefined when it can send. Every refusal says what to do; none
 * is silent. `stateHead` is the head the review state was read at, `headSha` the PR's.
 */
export function submitBlocked(input: {
  ready: boolean;
  writing: boolean;
  locked: boolean;
  canComment: boolean;
  headSha: string;
  stateHead: string;
  drafts: readonly ForgeReviewDraft[];
  hostedPending?: ForgeHostedPendingReview | null | undefined;
  /** Neither a summary nor an approval to send. */
  empty: boolean;
}): string | undefined {
  if (input.locked) return lockedText;
  if (!input.canComment) return "GitHub doesn't let this account comment on this pull request.";
  if (input.hostedPending)
    return `You have a review pending on GitHub with ${comments(input.hostedPending.comments)}. GitHub keeps one pending review a person: submit or discard that one on GitHub first.`;
  if (!input.ready) return "Reading your review from GitHub…";
  if (input.stateHead !== input.headSha)
    return "New commits arrived. Checking your review against them…";
  const standing = input.drafts.map((d) => draftStanding(d, input.headSha));
  if (standing.includes("moving")) return "Moving your pending comments to the new commits…";
  const outdated = standing.filter((s) => s === "outdated").length;
  if (outdated)
    return `New commits changed the lines of ${comments(outdated)}. Post ${outdated === 1 ? "it" : "them"} on ${outdated === 1 ? "its file" : "their files"} or remove ${outdated === 1 ? "it" : "them"} to submit.`;
  if (input.writing) return "Waiting for GitHub…";
  if (input.empty) return "Write a summary, add a line comment, or approve.";
  return undefined;
}

/** A row of earlier code above a thread; `commented` marks the lines the thread is on. */
export type ThreadCodeRow = HunkRow & { commented: boolean };

/**
 * The last lines of the code a thread was written on, from GitHub's hunk, the commented lines
 * marked. Empty when GitHub sent no hunk.
 */
export function threadCode(
  thread: {
    hunk?: string | undefined;
    side?: "LEFT" | "RIGHT" | undefined;
    originalLine?: number | null | undefined;
    originalStartLine?: number | null | undefined;
  },
  keep: number,
): ThreadCodeRow[] {
  const rows = hunkRows(thread.hunk);
  const end = thread.originalLine ?? undefined;
  const start = thread.originalStartLine ?? end;
  const lineOf = (row: HunkRow) => (thread.side === "LEFT" ? row.left : row.right);
  return rows.slice(-keep).map((row) => {
    const line = lineOf(row);
    // With no line from GitHub, the hunk's last row is the commented one.
    const commented =
      end === undefined || start === undefined
        ? row === rows.at(-1)
        : line !== undefined && line >= start && line <= end;
    // The rows are this call's own: marking them in place copies nothing.
    return Object.assign(row, { commented });
  });
}
