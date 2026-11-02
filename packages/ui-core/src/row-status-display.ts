import type { RowAttention } from "./row-attention.ts";
import type { Tone } from "./status.ts";

/**
 * The solid status icons on thread rows (approved design
 * `/tmp/sidebar-mocks/status-icons-approved.html`, `solid` variant, viewBox `0 0 16 16`).
 * One component draws them (`apps/web/src/components/status-icons.tsx`); this mapping decides
 * which one a row shows, so iOS can reuse it. The existing attention (`rowAttention`) stays the
 * single rule for which state a row is in; only the presentation changes.
 *
 * Rows are quiet: colour only where the person is needed or something failed, and no status
 * words on the row itself. The meaning (`Needs approval`) goes in the tooltip and the row's
 * accessible name.
 * - needs-you: shield (approval), bubble (question), chip (model), else the shield. The icon
 *   alone, in the warning colour.
 * - failed: triangle. The icon alone, in the destructive colour.
 * - working: still quarter-filled circle, grey, then the elapsed time in muted ink.
 * - waiting: hourglass, grey, then the elapsed time.
 * - background: terminal, grey, then the elapsed time.
 * - failed-seen: the triangle in grey, then the age.
 * - done-unread, done-seen, idle: the age alone. An unread result is marked by its bold title.
 * - syncing: a quiet word, the one state with no icon or time to stand for it.
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

/** The colour a row's icon draws in: only needs-you and failed are coloured. */
export type RowStatusInk = "warning" | "destructive" | "muted";

export interface RowStatusLook {
  /** The solid icon a row draws, or `none` for no icon. */
  icon: RowStatusIconKind | "none";
  /** The state's `data-tone`, for the worded form (the hover card). */
  tone: RowStatusTone;
  /** The colour the row's icon draws in. */
  ink: RowStatusInk;
  /**
   * What the row shows: the icon alone, the icon (if any) and the live elapsed time, the icon
   * (if any) and the age, or a quiet word.
   */
  mode: "icon" | "elapsed" | "age" | "word";
  /** The short word the hover card shows beside the icon; undefined where it shows a time. */
  word: string | undefined;
  /** The state in a few plain words ("Needs approval"), for the tooltip and the row's name. */
  meaning: string;
  /** The card's own status label (the row's existing wording, unchanged). */
  full: string;
}

const approval = (label: string): boolean => /approv/i.test(label);
const answer = (label: string): boolean => /answer/i.test(label);
const review = (label: string): boolean => /review/i.test(label);

type Needs = Pick<RowStatusLook, "icon" | "word" | "meaning">;

function needs(old: string, full: string): Needs {
  if (old === "Approve" || approval(full))
    return { icon: "approve", word: "Approval", meaning: "Needs approval" };
  if (old === "Answer" || answer(full))
    return { icon: "question", word: "Question", meaning: "Has a question" };
  if (old === "Pick a model" || full === "Pick a model")
    return { icon: "model", word: "Model", meaning: "Needs a model" };
  if (old === "Needs you" && review(full))
    return { icon: "approve", word: "Review", meaning: "Needs a review" };
  if (old === "Not sent") return { icon: "approve", word: "Not sent", meaning: "Not sent" };
  if (old === "Needs you" || old.endsWith("needs you"))
    return { icon: "approve", word: "Request", meaning: "Needs you" };
  return { icon: "approve", word: old, meaning: old || full };
}

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
    case "needs-you":
      return {
        ...needs(attention.word ?? "", full),
        tone: "needs-you",
        ink: "warning",
        mode: "icon",
        full,
      };
    case "failed":
      return {
        icon: "failed",
        tone: "failed",
        ink: "destructive",
        mode: "icon",
        word: "Failed",
        meaning: "Failed",
        full,
      };
    case "active": {
      const busy = { ink: "muted", mode: "elapsed", word: undefined, full } as const;
      if (attention.tone === "working")
        return { ...busy, icon: "working", tone: "working", meaning: full };
      if (attention.tone === "background")
        return { ...busy, icon: "background", tone: "background", meaning: full };
      // A plain wait says what it waits for in the card's own words; a recovery keeps its own.
      const old = attention.word ?? "";
      const plain = old === "" || old === "Waiting" || old.startsWith("Limited");
      return { ...busy, icon: "waiting", tone: "waiting", meaning: plain ? full : old };
    }
    case "done-unread":
      return {
        icon: "none",
        tone: "unread",
        ink: "muted",
        mode: "age",
        word: "Done",
        meaning: "Done",
        full,
      };
    case "failed-seen":
      return {
        icon: "failed",
        tone: "idle",
        ink: "muted",
        mode: "age",
        word: "Failed",
        meaning: "Failed",
        full,
      };
    case "syncing":
      return {
        icon: "none",
        tone: "idle",
        ink: "muted",
        mode: "word",
        word: attention.word,
        meaning: attention.word ?? full,
        full,
      };
    case "quiet": {
      const finished = card.status.tone === "done" || card.status.label === "Done";
      return {
        icon: "none",
        tone: "idle",
        ink: "muted",
        mode: "age",
        word: undefined,
        meaning: finished ? "Done" : full,
        full,
      };
    }
  }
}
