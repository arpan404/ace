import type { ContextMeter, QueueSnapshot, ThreadStatus } from "@ace/protocol";
import { unavailableModelNotice } from "./model-availability.ts";
import type { ExecutionSelection } from "@ace/protocol";
import type { LimitContext } from "./limits.ts";
import { describeWake } from "./snooze.ts";
import { formatCountdown } from "./time.ts";

/*
 * Wording and choices for a thread's server queue (ADR 0053): why it is held and what the
 * person can do about it, and how full the agent's context is. Pure; the caller passes the clock.
 */

/** A limit or recovery choice the composer offers; each maps to one daemon command. */
export type QueueAction =
  | { id: "resume_now"; label: string }
  | { id: "resume_at_reset"; label: string }
  | { id: "snooze_until_reset"; label: string }
  | {
      id: "migrate_now";
      label: string;
      /** The account it moves to, when one is named. */ instanceId?: string;
    }
  | { id: "resume"; label: string }
  | { id: "hold"; label: string }
  | { id: "choose_model"; label: string };

export interface QueueNotice {
  kind:
    | "limited"
    | "resuming"
    | "snoozed"
    | "restart"
    | "uncertain"
    | "paused"
    | "model"
    | "not_sent";
  title: string;
  detail: string;
  /** In order of prominence; the first is the primary action. */
  actions: QueueAction[];
}

export type QueueHold = Pick<QueueSnapshot, "paused" | "reason" | "resumeAt" | "pendingCount">;

/**
 * Why the queue isn't sending, and the way out; undefined while it flows. `account` is what
 * `accounts.list` says about the account a limited thread ran out on, when it has loaded.
 */
export function queueNotice(
  status: ThreadStatus | undefined,
  queue: QueueHold | undefined,
  now: number,
  locale?: string,
  account?: LimitContext,
  unavailable?: { provider: ExecutionSelection["provider"]; model: string },
): QueueNotice | undefined {
  if (unavailable)
    return {
      kind: "model",
      title: unavailableModelNotice(unavailable),
      detail: "",
      actions: [{ id: "choose_model", label: "Pick another model" }],
    };
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
    // The thread's own reset, else the account's: the daemon resumes at the account's too.
    const until = (status?.state === "limited" ? status.until : undefined) ?? account?.resetsAt;
    const known = until !== undefined && until > now;
    const who = account?.name ?? "The account";
    const target = account?.target;
    const detail = known
      ? `${who} resets ${describeWake(until, now, locale)}, in ${formatCountdown(until - now)}.`
      : "The provider didn't say when it resets.";
    const stuck = target === null ? ` No other ${account?.providerLabel} account has room.` : "";
    return {
      kind: "limited",
      title: "Usage limit reached",
      detail: `${detail}${stuck} Queued messages wait.`,
      actions: [
        ...(known
          ? [
              { id: "resume_at_reset", label: "Resume at reset" } as const,
              { id: "snooze_until_reset", label: "Snooze until reset" } as const,
            ]
          : []),
        ...(target === null
          ? []
          : [
              target
                ? ({
                    id: "migrate_now",
                    label: `Move to ${target.name}`,
                    instanceId: target.id,
                  } as const)
                : ({ id: "migrate_now", label: "Move to another account" } as const),
            ]),
        { id: "resume_now", label: "Resume now" },
      ],
    };
  }
  switch (reason) {
    case "not_sent":
      return {
        kind: "not_sent",
        title: "Message not sent",
        detail: "Your message is kept in the queue. Try sending it again.",
        actions: [{ id: "resume", label: "Try again" }],
      };
    case "stopped":
      return {
        kind: "paused",
        title: "Agent stopped",
        detail: "Your queued messages are kept until you continue.",
        actions: [{ id: "resume", label: "Continue" }],
      };
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
        detail: "Send again may run it twice. Remove it if the agent already handled it.",
        actions: [],
      };
    case "manual":
      if (!(queue?.pendingCount ?? (status?.state === "waiting" && status.on === "queue" ? 1 : 0)))
        return undefined;
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

/**
 * The queue banner is already saying the account hit its limit (held, resuming at reset or
 * snoozed until it), so the transcript shouldn't repeat it as a live line.
 */
export function limitHoldShown(
  status: ThreadStatus | undefined,
  queue: QueueHold | undefined,
): boolean {
  const kind = queueNotice(status, queue, 0)?.kind;
  return kind === "limited" || kind === "resuming" || kind === "snoozed";
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
