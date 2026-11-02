import type { RowAttention } from "./row-attention.ts";
import type { Tone } from "./status.ts";

/**
 * The solid status icons on thread rows (approved design
 * `/tmp/sidebar-mocks/status-icons-approved.html`, `solid` variant, viewBox `0 0 16 16`).
 * One component draws them (`apps/web/src/components/status-icons.tsx`); this mapping decides
 * which one a row shows, so iOS can reuse it. The existing attention (`rowAttention`) stays the
 * single rule for which state a row is in; only the presentation changes.
 *
 * - needs-you: shield (approval), bubble (question), chip (model), else the shield with a short
 *   noun. Warning colour, word in the state's colour.
 * - failed: triangle. Destructive colour, word in the state's colour.
 * - working: still quarter-filled circle. Working blue icon, elapsed time in muted ink.
 * - waiting: hourglass. Waiting violet icon, elapsed time in muted ink.
 * - background: terminal. Muted icon, elapsed time in muted ink.
 * - done-unread: filled circle. Unseen blue icon, `Done` in the state's colour.
 * - done-seen/idle: small check (or nothing without a finished turn). Subtle icon, relative
 *   time in muted ink.
 * Nothing animates on rows.
 */

export type RowStatusIconKind =
  | "approve"
  | "question"
  | "model"
  | "failed"
  | "working"
  | "waiting"
  | "background"
  | "done"
  | "seen";

export type RowStatusTone =
  | "needs-you"
  | "failed"
  | "working"
  | "waiting"
  | "background"
  | "unread"
  | "idle";

export interface RowStatusLook {
  /** The solid icon to draw, or `none` for a quiet word with no icon. */
  icon: RowStatusIconKind | "none";
  /** The `data-tone` the icon (and a coloured word) draws in. */
  tone: RowStatusTone;
  /** How the row words its line: a short static word, its live elapsed time, or its age. */
  mode: "word" | "elapsed" | "age";
  /** The visual short word for `word` mode; undefined for times, which the row computes. */
  word: string | undefined;
  /** The full wording for assistive tech (the row's existing status label, unchanged). */
  full: string;
}

const approval = (label: string): boolean => /approv/i.test(label);
const answer = (label: string): boolean => /answer/i.test(label);
const review = (label: string): boolean => /review/i.test(label);

/**
 * Which solid icon, colour and wording a row shows for its attention. Pure: the caller passes
 * the card's status label (for the full wording) and tone (to know a quiet row finished).
 */
export function rowStatusLook(
  attention: RowAttention,
  card: { status: { label: string; tone: Tone } },
): RowStatusLook {
  const full = card.status.label;
  switch (attention.level) {
    case "needs-you": {
      const old = attention.word ?? "";
      if (old === "Approve" || approval(full))
        return { icon: "approve", tone: "needs-you", mode: "word", word: "Approval", full };
      if (old === "Answer" || answer(full))
        return { icon: "question", tone: "needs-you", mode: "word", word: "Question", full };
      if (old === "Pick a model" || full === "Pick a model")
        return { icon: "model", tone: "needs-you", mode: "word", word: "Model", full };
      if (old === "Needs you" && review(full))
        return { icon: "approve", tone: "needs-you", mode: "word", word: "Review", full };
      if (old === "Not sent")
        return { icon: "approve", tone: "needs-you", mode: "word", word: "Not sent", full };
      if (old === "Needs you" || old.endsWith("needs you"))
        return { icon: "approve", tone: "needs-you", mode: "word", word: "Request", full };
      return { icon: "approve", tone: "needs-you", mode: "word", word: old, full };
    }
    case "failed":
      return { icon: "failed", tone: "failed", mode: "word", word: "Failed", full };
    case "active": {
      if (attention.tone === "working")
        return { icon: "working", tone: "working", mode: "elapsed", word: undefined, full };
      if (attention.tone === "background")
        return {
          icon: "background",
          tone: "background",
          mode: "elapsed",
          word: undefined,
          full,
        };
      const old = attention.word ?? "";
      if (old === "Waiting" || old.startsWith("Limited"))
        return { icon: "waiting", tone: "waiting", mode: "elapsed", word: undefined, full };
      return { icon: "waiting", tone: "waiting", mode: "word", word: old, full };
    }
    case "done-unread":
      return { icon: "done", tone: "unread", mode: "word", word: "Done", full };
    case "failed-seen":
      return { icon: "none", tone: "idle", mode: "word", word: "Failed", full };
    case "syncing":
      return { icon: "none", tone: "idle", mode: "word", word: attention.word, full };
    case "quiet": {
      const finished = card.status.tone === "done" || card.status.label === "Done";
      return finished
        ? { icon: "seen", tone: "idle", mode: "age", word: undefined, full }
        : { icon: "none", tone: "idle", mode: "age", word: undefined, full };
    }
  }
}
