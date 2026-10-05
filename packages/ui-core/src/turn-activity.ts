import type { ThreadReader } from "@ace/client";
import type { Interaction, ThreadStatus } from "@ace/protocol";
import { agentName } from "./agents.ts";
import { providerNames } from "./providers.ts";
import { limitHoldShown } from "./queue.ts";
import { formatClock, formatElapsed } from "./time.ts";
import { ledgerOf } from "./thread-ledger.ts";
import { describeStep } from "./work-log.ts";

/*
 * A turn's one live line (UX audit TS-1, TS-2): what the agent is doing now, read by both the
 * transcript's bottom work-log header and the live footer, so the two can never disagree and
 * never show at once. Time the turn spent waiting on a person is not counted as working. Pure.
 */

/**
 * `working` moves (spinner, shimmer, a timer); `needs-you` waits on the person (no timer);
 * `held` waits on something outside the agent and stays still; `paused` is a usage-limit pause,
 * drawn as a divider.
 */
export type ActivityTone = "working" | "needs-you" | "held" | "paused";

export interface TurnActivity {
  /** "Working", "Waiting for your approval", "Waiting on a and b", "Rate limited · …". */
  label: string;
  tone: ActivityTone;
  /**
   * The timer's origin, already moved later by the time spent waiting on a person:
   * "Working for {now - elapsedFrom}". Undefined when the line has no timer.
   */
  elapsedFrom: number | undefined;
  /** The step in flight: "Running bun install". */
  current: string | undefined;
}

export type ActivityReader = Pick<
  ThreadReader,
  | "order"
  | "item"
  | "run"
  | "agent"
  | "thread"
  | "interactionIds"
  | "interaction"
  | "taskIds"
  | "task"
  | "queue"
>;

export interface ActivityOptions {
  /** The thread's list status: a limit hold the queue banner shows reads as a pause. */
  threadStatus?: ThreadStatus | undefined;
  /** A Stop is on its way to the daemon. */
  stopping?: boolean | undefined;
}

/** "Working for 1m 14s", or the label alone when the line has no timer. */
export function activityText(activity: TurnActivity, now: number): string {
  if (activity.elapsedFrom === undefined) return activity.label;
  return `${activity.label} for ${formatElapsed(Math.max(0, now - activity.elapsedFrom))}`;
}

/** "Paused · Codex usage limit · resets 6:00 PM": a usage-limit pause, live or in history. */
export function pauseLabel(
  provider: string | undefined,
  reset: { until: number | undefined } | undefined,
): string {
  const parts = ["Paused", provider ? `${provider} usage limit` : "Usage limit"];
  if (reset)
    parts.push(
      reset.until === undefined ? "reset time unknown" : `resets ${formatClock(reset.until)}`,
    );
  return parts.join(" · ");
}

function list(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** "Waiting for your approval" / "… your answer" / "… your review", by what is asked. */
function waitingOnYou(interactions: readonly Interaction[]): TurnActivity {
  const kinds = new Set(interactions.map((interaction) => interaction.request.kind));
  const label = kinds.has("approval")
    ? "Waiting for your approval"
    : kinds.has("plan_review")
      ? "Waiting for your review"
      : "Waiting for your answer";
  return { label, tone: "needs-you", elapsedFrom: undefined, current: undefined };
}

const line = (label: string, tone: ActivityTone): TurnActivity => ({
  label,
  tone,
  elapsedFrom: undefined,
  current: undefined,
});

const activityLabels: Partial<Record<string, string>> = {
  compacting: "Compacting context",
  retrying: "Retrying",
};

/** The turn's live line, and the entity keys whose changes can move it (to subscribe to). */
export interface ActivityReading {
  activity: TurnActivity | undefined;
  /** `item:…`, `agent:…` and `task:…` keys the line was read from, beyond the root agent. */
  watch: readonly string[];
}

/**
 * The turn's one live line, from the root agent's status and everything waiting on the person.
 * Undefined when nothing is live (the turn ended and nothing waits on the person).
 */
export function turnActivity(
  reader: ActivityReader,
  rootId: string,
  options: ActivityOptions = {},
): TurnActivity | undefined {
  return readTurnActivity(reader, rootId, options).activity;
}

/** `turnActivity`, with what it read. Costs what changed (the thread's shared ledger). */
export function readTurnActivity(
  reader: ActivityReader,
  rootId: string,
  options: ActivityOptions = {},
): ActivityReading {
  const watch: string[] = [];
  const activity = readActivity(reader, rootId, options, watch);
  return { activity, watch };
}

function readActivity(
  reader: ActivityReader,
  rootId: string,
  options: ActivityOptions,
  watch: string[],
): TurnActivity | undefined {
  const status = reader.agent(rootId)?.status;
  if (!status) return undefined;
  const ledger = ledgerOf(reader);
  const pending = [...ledger.pending()];
  const live =
    status.state !== "idle" && status.state !== "interrupted" && status.state !== "failed";
  if (options.stopping && live) return line("Stopping…", "working");
  // Anything the person must answer before the agent can go on: no timer, a needs-you mark.
  const blocking = pending.filter((interaction) => interaction.blocking);
  if (blocking.length && live) return waitingOnYou(blocking);
  switch (status.state) {
    case "starting":
      return line("Starting", "working");
    case "working": {
      const stretch = ledger.currentStretch(reader);
      for (const id of stretch.watch) watch.push(`item:${id}`);
      // Every wait since the stretch began has closed (an open one reads as waiting on you).
      const elapsedFrom =
        stretch.start === undefined
          ? undefined
          : stretch.start +
            ledger.waitedWithin(stretch.start, Number.POSITIVE_INFINITY, stretch.start);
      const step = stretch.current ? describeStep(stretch.current) : undefined;
      const current = step ? [step.verb, step.target].filter(Boolean).join(" ") : status.detail;
      const label =
        activityLabels[status.activity] ??
        (elapsedFrom === undefined && status.activity === "thinking" ? "Thinking" : "Working");
      return { label, tone: "working", elapsedFrom, current };
    }
    case "blocked": {
      if (status.on === "human") return waitingOnYou(pending);
      if (status.on === "subagents") {
        const names = status.refs.flatMap((id) => {
          watch.push(`agent:${id}`);
          const agent = reader.agent(id);
          return agent ? [agentName(agent)] : [];
        });
        return line(names.length ? `Waiting on ${list(names)}` : "Waiting on subagents", "working");
      }
      if (status.on === "background_task") {
        const titles = status.refs.flatMap((id) => {
          watch.push(`task:${id}`);
          const task = reader.task(id);
          return task ? [task.title] : [];
        });
        return line(
          titles.length ? `Waiting on ${list(titles)}` : "Waiting on a background task",
          "working",
        );
      }
      if (status.on === "rate_limit" && limitHoldShown(options.threadStatus, reader.queue)) {
        const limited =
          options.threadStatus?.state === "limited" ? options.threadStatus.until : undefined;
        const provider = reader.thread ? providerNames[reader.thread.provider] : undefined;
        return line(pauseLabel(provider, { until: status.until ?? limited }), "paused");
      }
      const reason = {
        rate_limit: "Rate limited",
        network: "Network trouble",
        upstream: "Provider unavailable",
      }[status.on];
      return line(
        status.until === undefined
          ? reason
          : `${reason} · retrying at ${formatClock(status.until)}`,
        "held",
      );
    }
    case "unresponsive":
      return line("Not responding", "held");
    default:
      // The turn is over; a question it left behind still waits on the person.
      return pending.length ? waitingOnYou(pending) : undefined;
  }
}

export function sameActivity(a: TurnActivity | undefined, b: TurnActivity | undefined): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.label === b.label &&
      a.tone === b.tone &&
      a.elapsedFrom === b.elapsedFrom &&
      a.current === b.current)
  );
}
