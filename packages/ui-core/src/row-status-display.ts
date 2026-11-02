import type { RowAttention } from "./row-attention.ts";
import type { Tone } from "./status.ts";

/**
 * Which status icon and colour a thread row shows, and its meaning in words. One component
 * draws the icons (`apps/web/src/components/status-icons.tsx`, Phosphor); this mapping decides
 * which one a row shows, so iOS can reuse it. The existing attention (`rowAttention`) stays the
 * single rule for which state a row is in; only the presentation changes.
 *
 * Each state has its own colour (its `tone`). No status words on the row itself: the meaning
 * (`Needs approval`) goes in the tooltip and the row's accessible name.
 * - needs-you: hand (approval, and any other request), question mark (question), sliders
 *   (model). The icon alone.
 * - failed: warning circle, alone.
 * - done-unread: check circle, alone.
 * - working: dashed circle, then the elapsed time.
 * - waiting on agents: a dashed circle holding how many it waits on, then the elapsed time.
 *   Any other wait (the queue, a recovery to review) draws a countdown clock in the waiting
 *   colour, then the elapsed time.
 * - limited (held at a usage limit): a gauge, alone. No timer: nothing is happening, and when
 *   it lifts is in the tooltip ("Limited 14:02").
 * - background: terminal window, then the elapsed time.
 * - failed-seen: the warning circle in the quiet idle colour, then the age.
 * - done-seen, idle: the age alone.
 * - syncing: a quiet word, the one state with no icon or time to stand for it.
 * Nothing animates on rows.
 */

export type RowStatusIconKind =
  | "approve"
  | "question"
  | "model"
  | "failed"
  | "working"
  | "agents"
  | "waiting"
  | "background"
  | "limited"
  | "done";

/** The colour a row's icon draws in, one per state. */
export type RowStatusTone =
  | "needs-you"
  | "failed"
  | "working"
  | "waiting"
  | "background"
  | "limited"
  | "finished"
  | "idle";

export interface RowStatusLook {
  /** The icon a row draws, or `none` for no icon. */
  icon: RowStatusIconKind | "none";
  /** The colour the icon draws in. */
  tone: RowStatusTone;
  /** How many agents the thread waits on, for the `agents` icon. */
  count: number | undefined;
  /**
   * What the row shows: the icon alone, the icon (if any) and the live elapsed time, the icon
   * (if any) and the age, or a quiet word.
   */
  mode: "icon" | "elapsed" | "age" | "word";
  /** The short word for the request ("Approval"); undefined where the row shows a time. */
  word: string | undefined;
  /** The state in a few plain words ("Needs approval"), for the tooltip and the row's name. */
  meaning: string;
  /** The card's own status label (the row's existing wording, unchanged). */
  full: string;
}

/** "Waiting on 3 agents"; "Waiting on agents" when the count is unknown. */
export function waitingOnAgentsLabel(count: number | undefined): string {
  if (!count) return "Waiting on agents";
  return `Waiting on ${count} ${count === 1 ? "agent" : "agents"}`;
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
 * Which icon, colour and wording a row shows for its attention. Pure: the caller passes the
 * card's status label (for the full wording), its tone (to know a quiet row finished) and, while
 * its tree waits on subagents, how many.
 */
export function rowStatusLook(
  attention: RowAttention,
  card: { status: { label: string; tone: Tone; waitingOn?: number | undefined } },
): RowStatusLook {
  const full = card.status.label;
  const look = { count: undefined, full };
  switch (attention.level) {
    case "needs-you":
      return { ...look, ...needs(attention.word ?? "", full), tone: "needs-you", mode: "icon" };
    case "failed":
      return {
        ...look,
        icon: "failed",
        tone: "failed",
        mode: "icon",
        word: "Failed",
        meaning: "Failed",
      };
    case "active": {
      const busy = { ...look, mode: "elapsed", word: undefined } as const;
      if (attention.tone === "working")
        return { ...busy, icon: "working", tone: "working", meaning: full };
      if (attention.tone === "background")
        return { ...busy, icon: "background", tone: "background", meaning: full };
      const agents = card.status.waitingOn;
      if (agents !== undefined)
        return {
          ...busy,
          icon: "agents",
          tone: "waiting",
          count: agents,
          meaning: waitingOnAgentsLabel(agents),
        };
      const old = attention.word ?? "";
      // Held at a usage limit: its own mark and no running time; the tooltip says when it lifts.
      if (old.startsWith("Limited") || full.startsWith("Limited"))
        return {
          ...look,
          icon: "limited",
          tone: "limited",
          mode: "icon",
          word: "Limited",
          meaning: full,
        };
      // A plain wait says what it waits for in the card's own words; a recovery keeps its own.
      const plain = old === "" || old === "Waiting";
      return { ...busy, icon: "waiting", tone: "waiting", meaning: plain ? full : old };
    }
    case "done-unread":
      return {
        ...look,
        icon: "done",
        tone: "finished",
        mode: "icon",
        word: "Done",
        meaning: "Finished",
      };
    case "failed-seen":
      return {
        ...look,
        icon: "failed",
        tone: "idle",
        mode: "age",
        word: "Failed",
        meaning: "Failed",
      };
    case "syncing":
      return {
        ...look,
        icon: "none",
        tone: "idle",
        mode: "word",
        word: attention.word,
        meaning: attention.word ?? full,
      };
    case "quiet": {
      const finished = card.status.tone === "done" || card.status.label === "Done";
      return {
        ...look,
        icon: "none",
        tone: "idle",
        mode: "age",
        word: undefined,
        meaning: finished ? "Done" : full,
      };
    }
  }
}
