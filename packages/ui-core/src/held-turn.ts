import { isLimitError, type ErrorView } from "./error-display.ts";
import type { QueueAction, QueueNotice } from "./queue.ts";
import { describeWake } from "./snooze.ts";
import { formatCountdown } from "./time.ts";

/*
 * A usage or rate limit holding the thread, said once in the strip on top of the composer as
 * one sentence ("Codex is out of usage until 1:14 AM"), with its ways on: switch account or
 * provider, resume at reset, or Continue. Once the person chose to resume at reset it says when
 * ("Resumes at 1:14 AM when Codex resets"), with Cancel. The transcript never repeats it. Pure.
 */

export interface HeldTurn {
  kind: "limited" | "resuming" | "snoozed" | "limit_failed";
  /** "Codex is out of usage", "Claude is rate limited". */
  lead: string;
  /** When it lifts, as a clock time ("1:14 AM", "tomorrow 1:14 AM"), when known. */
  until: string | undefined;
  /** The person already chose to resume then: the turn carries on by itself at `until`. */
  scheduled: boolean;
  /** How long until then, while scheduled: "1h 28m". */
  left: string | undefined;
  /** Calls a scheduled resume off: the thread goes back to waiting on its limit. */
  cancel: QueueAction | undefined;
  /** Who reset: "Codex". */
  who: string;
  /** Resume by itself once the limit resets, offered while the reset is known and not chosen. */
  atReset: QueueAction | undefined;
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
    const known = at !== undefined && at > now;
    const scheduled = notice.kind === "resuming" && known;
    return {
      kind: notice.kind as HeldTurn["kind"],
      lead: `${who} is out of usage`,
      until: known ? describeWake(at, now, locale) : undefined,
      scheduled,
      left: scheduled ? formatCountdown(at - now) : undefined,
      cancel: scheduled ? notice.actions.find((action) => action.id === "cancel_resume") : undefined,
      who,
      atReset: notice.actions.find((action) => action.id === "resume_at_reset"),
      carryOn: { id: "resume_now", label: "Continue" },
    };
  }
  if (!failure || !isLimitError(failure)) return undefined;
  return {
    kind: "limit_failed",
    lead: failure.code === "rate_limit" ? `${who} is rate limited` : `${who} is out of usage`,
    until: undefined,
    scheduled: false,
    left: undefined,
    cancel: undefined,
    who,
    atReset: undefined,
    carryOn: { id: "continue", label: "Continue" },
  };
}

/**
 * How a scheduled resume opens: "Resumes at " before a clock time, "Resumes " before a day
 * ("Resumes tomorrow 1:14 AM").
 */
export function scheduledLead(turn: Pick<HeldTurn, "until">): string {
  return /^\d/.test(turn.until ?? "") ? "Resumes at " : "Resumes ";
}

/**
 * The strip's sentence: "Codex is out of usage until 1:14 AM", or once the person chose to
 * resume then, "Resumes at 1:14 AM when Codex resets · in 1h 28m".
 */
export function heldTurnSentence(turn: HeldTurn): string {
  if (turn.scheduled && turn.until)
    return `${scheduledLead(turn)}${turn.until} when ${turn.who} resets${turn.left ? ` · in ${turn.left}` : ""}`;
  return turn.until ? `${turn.lead} until ${turn.until}` : turn.lead;
}
