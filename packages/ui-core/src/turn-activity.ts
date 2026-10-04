import type { ThreadReader } from "@ace/client";
import type { Interaction, Item, ThreadStatus } from "@ace/protocol";
import { agentName } from "./agents.ts";
import { providerNames } from "./providers.ts";
import { limitHoldShown } from "./queue.ts";
import { formatClock, formatElapsed } from "./time.ts";
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
  | "task"
  | "queue"
>;

export interface ActivityOptions {
  /** The thread's list status: a limit hold the queue banner shows reads as a pause. */
  threadStatus?: ThreadStatus | undefined;
  /** A Stop is on its way to the daemon. */
  stopping?: boolean | undefined;
}

/** One span of a turn spent waiting on a person: from the request to its answer. */
export interface WaitSpan {
  from: number;
  /** Undefined while still waiting. */
  to: number | undefined;
}

/** Requests that held the agent until a person answered (not ace's own auto-review). */
function waitedOnPerson(interaction: Interaction): boolean {
  return interaction.blocking && interaction.autoReviewed !== true;
}

/** Every span the thread's agents waited on a person, in the loaded state. */
export function humanWaits(reader: Pick<ActivityReader, "interactionIds" | "interaction">) {
  const spans: WaitSpan[] = [];
  for (const id of reader.interactionIds()) {
    const interaction = reader.interaction(id);
    if (!interaction || !waitedOnPerson(interaction)) continue;
    spans.push({ from: interaction.createdAt, to: interaction.closedAt });
  }
  return spans.sort((a, b) => a.from - b.from);
}

/** How much of [from, to] was spent waiting on a person (overlapping waits count once). */
export function waitedWithin(
  spans: readonly WaitSpan[],
  from: number,
  to: number,
  now = to,
): number {
  let total = 0;
  let reached = from;
  for (const span of spans) {
    const start = Math.max(span.from, reached);
    const end = Math.min(span.to ?? now, to);
    if (end > start) {
      total += end - start;
      reached = end;
    }
  }
  return total;
}

/** How long [from, to] was spent working: the span less the waits on a person within it. */
export function workedFor(spans: readonly WaitSpan[], from: number, to: number): number {
  return Math.max(0, to - from - waitedWithin(spans, from, to));
}

/** "Working for 1m 14s", or the label alone when the line has no timer. */
export function activityText(activity: TurnActivity, now: number): string {
  if (activity.elapsedFrom === undefined) return activity.label;
  return `${activity.label} for ${formatElapsed(Math.max(0, now - activity.elapsedFrom))}`;
}

/**
 * Whether an item ends the stretch of work before it: the agent's prose, the person's own
 * message, or a question to the person. The transcript closes its "Worked for" group there too.
 */
export function closesStretch(item: Item): boolean {
  if (item.type === "message") return !item.synthetic;
  return item.type === "tool_call" && item.call.detail.kind === "ask_user";
}

const unsettled = new Set(["pending", "running"]);

/**
 * The current stretch of work: when it started, and the newest step still in flight. Walks back
 * from the newest item to the last prose, the person's message, or an item of an earlier turn.
 */
function currentStretch(reader: ActivityReader): { start?: number; current?: Item } {
  let start: number | undefined;
  let current: Item | undefined;
  for (let index = reader.order.length - 1; index >= 0; index--) {
    const item = reader.item(reader.order[index] ?? "");
    if (!item) continue;
    if (closesStretch(item)) break;
    const run = item.runId ? reader.run(item.runId) : undefined;
    if (run && run.state !== "active" && run.agentId === reader.thread?.rootAgentId) break;
    if (item.type === "message" || item.type === "compaction" || item.type === "artifact") continue;
    if (item.type === "tool_call" && item.call.detail.kind === "agent.spawn") continue;
    const at =
      item.type === "tool_call" ? Math.min(item.createdAt, item.call.startedAt) : item.createdAt;
    start = start === undefined ? at : Math.min(start, at);
    if (!current && item.type === "tool_call" && unsettled.has(item.call.status)) current = item;
  }
  return { ...(start === undefined ? {} : { start }), ...(current ? { current } : {}) };
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

/**
 * The turn's one live line, from the root agent's status and everything waiting on the person.
 * Undefined when nothing is live (the turn ended and nothing waits on the person).
 */
export function turnActivity(
  reader: ActivityReader,
  rootId: string,
  options: ActivityOptions = {},
): TurnActivity | undefined {
  const status = reader.agent(rootId)?.status;
  if (!status) return undefined;
  const pending = reader.interactionIds().flatMap((id) => {
    const interaction = reader.interaction(id);
    return interaction?.state === "pending" ? [interaction] : [];
  });
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
      const stretch = currentStretch(reader);
      const elapsedFrom =
        stretch.start === undefined
          ? undefined
          : stretch.start +
            waitedWithin(humanWaits(reader), stretch.start, Number.POSITIVE_INFINITY);
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
          const agent = reader.agent(id);
          return agent ? [agentName(agent)] : [];
        });
        return line(names.length ? `Waiting on ${list(names)}` : "Waiting on subagents", "working");
      }
      if (status.on === "background_task") {
        const titles = status.refs.flatMap((id) => {
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
        const until = status.until ?? limited;
        const provider = reader.thread ? providerNames[reader.thread.provider] : undefined;
        return line(
          [
            "Paused",
            provider ? `${provider} usage limit` : "Usage limit",
            until === undefined ? "reset time unknown" : `resets ${formatClock(until)}`,
          ].join(" · "),
          "paused",
        );
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
