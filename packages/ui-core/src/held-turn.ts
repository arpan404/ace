import { isLimitError, type ErrorView } from "./error-display.ts";
import type { QueueAction, QueueNotice } from "./queue.ts";

/*
 * Why the thread's turn is held, said once in the colored strip on top of the composer: a usage
 * or rate limit, a restart, or a Stop. The transcript never repeats it. Pure.
 */

/** The strip's hue, from the status vocabulary: limits are violet, a restart or a pause amber. */
export type HeldTurnTone = "waiting" | "needs-you" | "failed" | undefined;

export interface HeldTurn {
  kind: QueueNotice["kind"] | "limit_failed";
  tone: HeldTurnTone;
  title: string;
  detail: string;
  /** In order of prominence; the first is the primary action. */
  actions: QueueAction[];
}

const tones: Partial<Record<HeldTurn["kind"], HeldTurnTone>> = {
  limited: "waiting",
  resuming: "waiting",
  snoozed: "waiting",
  limit_failed: "waiting",
  restart: "needs-you",
  stopped: "needs-you",
};

/** Queue holds that are about the turn itself: they leave the queue's strip for this one. */
export function holdsTurn(notice: QueueNotice | undefined): boolean {
  return (
    notice?.kind === "limited" ||
    notice?.kind === "resuming" ||
    notice?.kind === "snoozed" ||
    notice?.kind === "restart" ||
    notice?.kind === "stopped"
  );
}

/**
 * The held turn to show, if any: the queue's hold first (it knows the reset and the ways out),
 * else the newest turn that ended on a usage or rate limit with nothing run since, whose way on
 * is Continue.
 */
export function heldTurn(
  notice: QueueNotice | undefined,
  failure: Pick<ErrorView, "code" | "title" | "message"> | undefined,
): HeldTurn | undefined {
  if (notice && holdsTurn(notice)) return { ...notice, tone: tones[notice.kind] };
  if (!failure || !isLimitError(failure)) return undefined;
  return {
    kind: "limit_failed",
    tone: tones.limit_failed,
    title: failure.title,
    detail: failure.message ?? "",
    actions: [{ id: "continue", label: "Continue" }],
  };
}
