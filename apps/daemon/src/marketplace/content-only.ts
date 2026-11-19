import type { MarketReviewBody } from "@ace/protocol/marketplace";
import type { PreparedReview } from "./review.ts";
import type { Provenance } from "./store.ts";

/**
 * Whether installing `review` lands content only (ADR 0178 §12.8): a Suit, whose scenes run
 * sandboxed in the page, or a Spade skill, which runs nothing outside Spade's own gate and which
 * no bot sees until the person turns it on. Such an install needs no fresh sign-in. Read from the
 * review this daemon built from the bytes it fetched and checked, never from anything the client
 * sent: its type and its body's type must agree, and it must carry nothing runnable. That rules
 * out a plugin's executions, an executable file, and entries it brings along (a recipe's). Bots
 * and plugins run commands or MCP servers, so they never count.
 *
 * It must also come from where the entry of the same type and name last came from (`previous`:
 * the installed record, or the one its removal left, so removing doesn't make a name new again):
 * a name never installed here, or the same source, with the same publisher when that was signed. Anything else replaces what the person chose with
 * something from elsewhere, so it is the person's: another catalog, unsigned bytes over signed
 * ones, another publisher, or an installed record from before provenance was kept. Pure.
 */
export function contentOnlyReview(
  review: PreparedReview,
  body: MarketReviewBody,
  previous: Provenance | undefined,
): boolean {
  if (review.type !== "suit" && review.type !== "spade-skill") return false;
  if (body.type !== review.type) return false;
  if (review.plugin !== undefined || review.brings.length > 0) return false;
  if (!review.checked.files.every((file) => !file.executable)) return false;
  return previous === undefined || sameProvenance(previous, review);
}

/** Whether `review` comes from where the installed `previous` did. */
function sameProvenance(previous: Provenance, review: PreparedReview): boolean {
  if (previous.signed === undefined || previous.source !== review.source) return false;
  if (!previous.signed) return true;
  return review.signed && review.publisher?.id === previous.publisher;
}
