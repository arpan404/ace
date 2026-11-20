import { suggestionOf } from "@ace/forge/suggestions";
import { can, type ForgeCapabilitySource } from "./forge-capability.ts";

/*
 * What a reviewer's suggested change offers, the same on every client: GitHub commits it while
 * its lines are on the current diff; once a push outdated it, only an agent can still apply it.
 * The commit messages are the ones GitHub's own buttons prefill.
 */

export interface SuggestionOffer {
  /** The suggested replacement lines. */
  lines: string[];
  /** GitHub can commit it (Commit suggestion, Add to batch); false hands it to the agent. */
  commit: boolean;
}

/** The suggestion an inline comment offers, or undefined when it holds none to apply. */
export function suggestionOffer(
  comment: { kind: string; body: string },
  outdated: boolean,
  source: ForgeCapabilitySource | null | undefined,
): SuggestionOffer | undefined {
  if (comment.kind !== "inline" || !can(source, "reviews.suggestions")) return undefined;
  const lines = suggestionOf(comment.body);
  return lines ? { lines, commit: !outdated } : undefined;
}

/** What committing one suggestion says, prefilled and editable. */
export const suggestionCommitMessage = (author: string) => `Apply suggestion from @${author}`;
/** What committing a batch says, prefilled and editable. */
export const suggestionBatchMessage = "Apply suggestions from code review";
/** A commit asked at a head the branch has since moved from: refused, nothing written. */
export const suggestionHeadMovedText =
  "The branch moved since you looked, so nothing was committed. Refresh to see the new commits, then commit the suggestion again.";
/** A commit whose answer was lost: it may have landed, so it is checked before any retry. */
export const suggestionUncertainText =
  "GitHub didn't confirm the commit. It may have gone through: refresh to check before trying again.";
