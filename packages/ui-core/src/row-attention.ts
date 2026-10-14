import type { Tone } from "./status.ts";

/**
 * How loudly a thread row asks for the person, strongest first:
 * - `needs-you`: a request, a sign-in, a send that failed and needs action. Never mutes.
 * - `failed`: failed and not yet seen since it failed.
 * - `done-unread`: a finished result the person hasn't opened.
 * - `active`: working, background commands, waiting on something outside ace. Calm: the live
 *   indicator moves, the words stay muted, nothing is asked of the person.
 * - `failed-seen`: failed, already seen. A real state, worded calmly.
 * - `quiet`: done and read, new, settled: nothing to do. No status word.
 *
 * Colour and full contrast are kept for what asks the person to act or look. The row the
 * person has open is full contrast whatever its level (`current`).
 */
export type AttentionLevel =
  | "needs-you"
  | "failed"
  | "done-unread"
  | "active"
  | "failed-seen"
  | "quiet";

export interface RowAttention {
  level: AttentionLevel;
  /** The status word the row shows; none for a quiet row, which shows its age instead. */
  word: string | undefined;
  /** The colour of the status mark (and of the word unless muted); `idle` is subdued ink. */
  tone: Tone;
  /** The title, meta and status word drop to the muted ink. */
  muted: boolean;
}

export interface RowAttentionInput {
  /** The row's status tone and its short word ("Approve", "Working", "Not sent"). */
  tone: Tone;
  word: string;
  /** Activity the person hasn't opened (a failure counts as activity). */
  unread: boolean;
  settled: boolean;
  /** The status is a recovery the person must act on (Not sent, Pick a model, Resume). */
  recovery?: boolean | undefined;
  /** The thread the person has open. */
  current?: boolean | undefined;
}

/**
 * One rule for every surface that shows a thread's status: the Home row, its hover card, the
 * settled row and Activity read it, so they never disagree. Pure.
 */
export function rowAttention(input: RowAttentionInput): RowAttention {
  return currentAttention(levelOf(input), input.current === true);
}

/** The open thread's row reads at full contrast, whatever its level. */
export function currentAttention(attention: RowAttention, current: boolean): RowAttention {
  return current && attention.muted ? { ...attention, muted: false } : attention;
}

function levelOf(input: RowAttentionInput): RowAttention {
  const { tone, word, unread } = input;
  // Needing the person outranks settling, reading and everything else.
  if (tone === "needs-you" || (input.recovery && tone === "failed"))
    return { level: "needs-you", word, tone: "needs-you", muted: false };
  if (tone === "failed")
    return unread
      ? { level: "failed", word, tone: "failed", muted: false }
      : { level: "failed-seen", word, tone: "idle", muted: true };
  // A recovery waits on the person's Resume or retry: settling never hides or mutes it.
  if (input.recovery) return { level: "active", word, tone, muted: false };
  if (input.settled) return { level: "quiet", word: undefined, tone: "idle", muted: true };
  if (tone === "working" || tone === "background" || tone === "waiting")
    return { level: "active", word, tone, muted: true };
  if (tone === "done" && unread) return { level: "done-unread", word, tone: "done", muted: false };
  return { level: "quiet", word: undefined, tone: "idle", muted: true };
}
