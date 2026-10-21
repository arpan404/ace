import { isLimitError, type ErrorView } from "./error-display.ts";
import type { QueueAction, QueueNotice } from "./queue.ts";
import { describeWake } from "./snooze.ts";

/*
 * A usage or rate limit holding the thread, said once in the strip on top of the composer as
 * one sentence ("Codex is out of usage until 1:14 AM"), with two ways on: switch account or
 * provider, or Continue. The transcript never repeats it. Pure.
 */

export interface HeldTurn {
  kind: "limited" | "resuming" | "snoozed" | "limit_failed";
  /** "Codex is out of usage", "Claude is rate limited". */
  lead: string;
  /** When it lifts, as a clock time ("1:14 AM", "tomorrow 1:14 AM"), when known. */
  until: string | undefined;
  /** What Continue does: resume the held turn now, or send the person's Continue message. */
  carryOn: QueueAction;
}

/** Queue holds that are a limit: they leave the queue's strip for this one. */
export function holdsTurn(notice: QueueNotice | undefined): boolean {
  return notice?.kind === "limited" || notice?.kind === "resuming" || notice?.kind === "snoozed";
}

/**
 * The limit to show, if any: the queue's limit hold first (it knows the reset), else the newest
 * turn that ended on a usage or rate limit with nothing run since. `who` names the provider.
 */
export function heldTurn(
  notice: QueueNotice | undefined,
  failure: Pick<ErrorView, "code"> | undefined,
  who: string,
  now: number,
  locale?: string,
): HeldTurn | undefined {
  if (notice && holdsTurn(notice)) {
    const at = notice.resetsAt;
    return {
      kind: notice.kind as HeldTurn["kind"],
      lead: `${who} is out of usage`,
      until: at !== undefined && at > now ? describeWake(at, now, locale) : undefined,
      carryOn: { id: "resume_now", label: "Continue" },
    };
  }
  if (!failure || !isLimitError(failure)) return undefined;
  return {
    kind: "limit_failed",
    lead: failure.code === "rate_limit" ? `${who} is rate limited` : `${who} is out of usage`,
    until: undefined,
    carryOn: { id: "continue", label: "Continue" },
  };
}

/** The strip's sentence: "Codex is out of usage until 1:14 AM". */
export function heldTurnSentence(turn: HeldTurn): string {
  return turn.until ? `${turn.lead} until ${turn.until}` : turn.lead;
}
