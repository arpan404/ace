import type { MarketReviewBody } from "@ace/protocol/marketplace";
import type { PreparedReview } from "./review.ts";

/**
 * Whether installing `review` lands content only (ADR 0178 §12.8): a Suit, whose scenes run
 * sandboxed in the page, or a Spade skill, which runs nothing outside Spade's own gate. Such an
 * install needs no fresh sign-in. Read from the review this daemon built from the bytes it
 * fetched and checked, never from anything the client sent: its type and its body's type must
 * agree, and it must carry nothing runnable. That rules out a plugin's executions, an executable
 * file, and entries it brings along (a recipe's). Bots and plugins run commands or MCP servers,
 * so they never count. Pure.
 */
export function contentOnlyReview(review: PreparedReview, body: MarketReviewBody): boolean {
  if (review.type !== "suit" && review.type !== "spade-skill") return false;
  if (body.type !== review.type) return false;
  if (review.plugin !== undefined || review.brings.length > 0) return false;
  return review.checked.files.every((file) => !file.executable);
}
