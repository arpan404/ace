import { isLimitError, type ErrorView } from "./error-display.ts";
import type { QueueAction, QueueNotice } from "./queue.ts";
import { formatCountdown } from "./time.ts";

/*
 * A usage or rate limit holding the thread, said once in the colored strip on top of the
 * composer: one short line and Continue. The transcript never repeats it. Pure.
 */

export interface HeldTurn {
  kind: "limited" | "resuming" | "snoozed" | "limit_failed";
  title: string;
  /** "Resets in 1h 28m", or empty when the provider didn't say. */
  detail: string;
  /** Continue first; the rest wait behind the strip's menu. */
  actions: QueueAction[];
}

const titles: Record<HeldTurn["kind"], string> = {
  limited: "Usage limit reached",
  resuming: "Usage limit reached",
  snoozed: "Snoozed until the limit resets",
  limit_failed: "Rate limited",
};

/** Queue holds that are a limit: they leave the queue's strip for this one. */
export function holdsTurn(notice: QueueNotice | undefined): boolean {
  return notice?.kind === "limited" || notice?.kind === "resuming" || notice?.kind === "snoozed";
}

/** Continue now leads as plain "Continue"; the other ways out keep their order after it. */
function continueFirst(actions: readonly QueueAction[]): QueueAction[] {
  const now = actions.find((action) => action.id === "resume_now");
  const rest = actions.filter((action) => action.id !== "resume_now");
  return now ? [{ id: "resume_now", label: "Continue" }, ...rest] : rest;
}

/**
 * The limit to show, if any: the queue's limit hold first (it knows the reset and the ways out),
 * else the newest turn that ended on a usage or rate limit with nothing run since.
 */
export function heldTurn(
  notice: QueueNotice | undefined,
  failure: Pick<ErrorView, "code" | "title"> | undefined,
  now: number,
): HeldTurn | undefined {
  if (notice && holdsTurn(notice)) {
    const kind = notice.kind as HeldTurn["kind"];
    const at = notice.resetsAt;
    const left = at !== undefined && at > now ? formatCountdown(at - now) : undefined;
    return {
      kind,
      title: titles[kind],
      detail: left ? `${kind === "resuming" ? "Continues" : "Resets"} in ${left}` : "",
      actions: continueFirst(notice.actions),
    };
  }
  if (!failure || !isLimitError(failure)) return undefined;
  return {
    kind: "limit_failed",
    title: failure.code === "rate_limit" ? titles.limit_failed : failure.title,
    detail: "",
    actions: [{ id: "continue", label: "Continue" }],
  };
}
