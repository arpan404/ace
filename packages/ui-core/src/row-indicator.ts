import type { RowAttention } from "./row-attention.ts";

/**
 * The one small mark a sidebar row carries at its right edge, from its attention level
 * (`rowAttention`), never from the status on its own:
 * - `needs-you`: a dot in the warning colour;
 * - `failed`: a dot in the failure colour, until the person has seen it;
 * - `unread`: a blue dot for finished work not yet opened;
 * - `live`: a ring in the status's own colour that breathes briefly, while the thread or the
 *   agent tree under it still works or waits.
 * Nothing for a thread at rest, a failure already seen, or a copy still syncing. Because the
 * level already folds in the agent tree, a thread whose tree still works never reads finished.
 */
export interface RowIndicator {
  kind: "needs-you" | "failed" | "unread" | "live";
  /** The `data-tone` it draws in. */
  tone: "needs-you" | "failed" | "unread" | "working" | "background" | "waiting";
}

export function rowIndicator(attention: RowAttention): RowIndicator | undefined {
  switch (attention.level) {
    case "needs-you":
      return { kind: "needs-you", tone: "needs-you" };
    case "failed":
      return { kind: "failed", tone: "failed" };
    case "done-unread":
      return { kind: "unread", tone: "unread" };
    case "active": {
      const tone = attention.tone;
      return {
        kind: "live",
        tone: tone === "background" || tone === "waiting" ? tone : "working",
      };
    }
    default:
      return undefined;
  }
}
