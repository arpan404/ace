import type { ContextMeter, QueueSnapshot, ThreadStatus } from "@ace/protocol";
import { describeWake } from "./snooze.ts";

/*
 * Wording and choices for a thread's server queue (ADR 0053): why it is held and what the
 * person can do about it, and how full the agent's context is. Pure; the caller passes the clock.
 */

/** A limit or recovery choice the composer offers; each maps to one daemon command. */
export type QueueAction =
  | { id: "resume_now"; label: string }
  | { id: "resume_at_reset"; label: string }
  | { id: "snooze_until_reset"; label: string }
  | { id: "migrate_now"; label: string }
  | { id: "resume"; label: string }
  | { id: "hold"; label: string };

export interface QueueNotice {
  kind: "limited" | "resuming" | "snoozed" | "restart" | "uncertain" | "paused";
  title: string;
  detail: string;
  /** In order of prominence; the first is the primary action. */
  actions: QueueAction[];
}

export type QueueHold = Pick<QueueSnapshot, "paused" | "reason" | "resumeAt">;

/** Why the queue isn't sending, and the way out; undefined while it flows. */
export function queueNotice(
  status: ThreadStatus | undefined,
  queue: QueueHold | undefined,
  now: number,
  locale?: string,
): QueueNotice | undefined {
  const reason = queue?.paused ? queue.reason : null;
  const resumeAt = queue?.resumeAt ?? null;
  if (reason === "limit" && resumeAt !== null)
    return {
      kind: "resuming",
      title: "Resumes when the limit resets",
      detail: `Queued messages send ${describeWake(resumeAt, now, locale)}.`,
      actions: [
        { id: "resume_now", label: "Resume now" },
        { id: "hold", label: "Don't resume" },
      ],
    };
  if (reason === "snooze")
    return {
      kind: "snoozed",
      title: "Snoozed until the limit resets",
      detail:
        resumeAt === null
          ? "Nothing sends until you resume."
          : `Resets ${describeWake(resumeAt, now, locale)}. Nothing sends until you resume.`,
      actions: [{ id: "resume_now", label: "Resume now" }],
    };
  if (status?.state === "limited" || reason === "limit") {
    const until = status?.state === "limited" ? status.until : undefined;
    const known = until !== undefined && until > now;
    return {
      kind: "limited",
      title: "Usage limit reached",
      detail: known
        ? `The account resets ${describeWake(until, now, locale)}. Queued messages wait.`
        : "The provider didn't say when it resets. Queued messages wait.",
      actions: [
        ...(known
          ? [
              { id: "resume_at_reset", label: "Resume at reset" } as const,
              { id: "snooze_until_reset", label: "Snooze until reset" } as const,
            ]
          : []),
        { id: "migrate_now", label: "Move to another account" },
        { id: "resume_now", label: "Resume now" },
      ],
    };
  }
  switch (reason) {
    case "restart":
      return {
        kind: "restart",
        title: "Stopped by a restart",
        detail: "Continue where the agent left off, then send what's queued.",
        actions: [{ id: "resume", label: "Continue" }],
      };
    case "uncertain":
      return {
        kind: "uncertain",
        title: "A message may already have reached the agent",
        detail: "Remove it below, or send it again as a new message, then continue.",
        actions: [],
      };
    case "manual":
      return {
        kind: "paused",
        title: "Queue paused",
        detail: "Queued messages wait until you resume.",
        actions: [{ id: "resume", label: "Resume" }],
      };
    default:
      return undefined;
  }
}

export interface ContextUsage {
  /** 0..100 when the window is known. */
  percent: number | undefined;
  /** "42%" or "84k tokens". */
  short: string;
  /** "84,000 of 200,000 tokens in context". */
  long: string;
  /** Most of the window is used: the next turns may compact. */
  high: boolean;
}

const compact = (tokens: number) =>
  tokens >= 1_000_000
    ? `${Math.round(tokens / 100_000) / 10}M`
    : tokens >= 1000
      ? `${Math.round(tokens / 1000)}k`
      : String(tokens);

/** How full the agent's context window is; undefined until a sample arrives. */
export function contextUsage(
  meter: ContextMeter | undefined,
  locale?: string,
): ContextUsage | undefined {
  if (!meter || meter.usedTokens === null) return undefined;
  const used = meter.usedTokens;
  const window = meter.windowTokens;
  const number = (value: number) => value.toLocaleString(locale);
  if (window === null)
    return {
      percent: undefined,
      short: `${compact(used)} tokens`,
      long: `${number(used)} tokens in context`,
      high: false,
    };
  const percent = Math.min(100, Math.round((used / window) * 100));
  return {
    percent,
    short: `${percent}%`,
    long: `${number(used)} of ${number(window)} tokens in context`,
    high: percent >= 80,
  };
}

/**
 * Where `queue.move` puts a message one step up or down: the id it goes after, null for the
 * front, undefined when it can't move that way. `ids` is the queue in order.
 */
export function queueMoveAfter(
  ids: readonly string[],
  index: number,
  step: -1 | 1,
): string | null | undefined {
  const target = index + step;
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) return undefined;
  if (step === 1) return ids[target];
  return target === 0 ? null : ids[target - 1];
}
