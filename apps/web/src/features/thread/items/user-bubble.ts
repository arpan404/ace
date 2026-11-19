/**
 * Shared geometry for the person's confirmed, pending and held messages: a tailless card-radius
 * bubble at the answers' reading size, at most 80% of the column. Long words, URLs and paths
 * wrap anywhere, so nothing is wider than the bubble.
 */
export const userBubble =
  "relative max-w-[80%] min-w-0 overflow-hidden rounded-lg bg-bubble px-3 py-2 font-prose text-prose wrap-anywhere whitespace-pre-wrap";
