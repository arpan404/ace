import type { ThreadReader } from "@ace/client";
import { isTestCommand } from "@ace/projection";
import type { AgentStatus, Interaction, Item, ThreadStatus } from "@ace/protocol";
import { turnTreeOf } from "./turn-tree.ts";
import { agentName } from "./agents.ts";
import {
  askingLabel,
  describeLive,
  treeWorking,
  type LiveFact,
  type RootStand,
} from "./live-status.ts";
import { providerNames } from "./providers.ts";
import { limitHoldShown } from "./queue.ts";
import { formatClock } from "./time.ts";
import { ledgerOf } from "./thread-ledger.ts";
import type { StepLabels } from "./tool-labels.ts";
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
  /** "Working", "Waiting for your approval", "Waiting on 2 subagents", "Rate limited · …". */
  label: string;
  /** A command the label names, shown as code after it: "Watching `bun run dev:relay`". */
  code?: string | undefined;
  tone: ActivityTone;
  /**
   * The timer's origin, already moved later by the time spent waiting on a person:
   * "Working for {now - elapsedFrom}". Undefined when the line has no timer.
   */
  elapsedFrom: number | undefined;
  /** The step in flight: "Running bun install". */
  current: string | undefined;
  subagents?: number | undefined;
  backgroundCommands?: number | undefined;
  /** While waiting on the person: the subagent or delegated child that asks, when not the root. */
  asker?: string | undefined;
}

export type ActivityReader = Pick<
  ThreadReader,
  | "order"
  | "item"
  | "run"
  | "runIds"
  | "agent"
  | "agentIds"
  | "thread"
  | "interactionIds"
  | "interaction"
  | "taskIds"
  | "task"
  | "queue"
>;

export interface ActivityOptions {
  labels?: StepLabels | undefined;
  /** The thread's list status: a limit hold the queue banner shows reads as a pause. */
  threadStatus?: ThreadStatus | undefined;
  /** A Stop is on its way to the daemon. */
  stopping?: boolean | undefined;
}

/**
 * The words before a turn's time: "Working for 3m 6s". A label already in motion ("Stopping…")
 * takes the time bare: "Stopping… 3s".
 */
export function timedWords(label: string): string {
  return label.endsWith("…") ? label : `${label} for`;
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

/** "Waiting for your approval" / "… your review" / "… your answer", by what is asked. */
function waitingOnYou(
  reader: ActivityReader,
  rootId: string,
  interactions: readonly Interaction[],
): TurnActivity {
  const kinds = new Set(interactions.map((interaction) => interaction.request.kind));
  const label = askingLabel(
    kinds.has("approval") ? "approval" : kinds.has("plan_review") ? "plan_review" : "question",
  );
  return {
    label,
    tone: "needs-you",
    elapsedFrom: undefined,
    current: undefined,
    asker: askerOf(reader, rootId, interactions),
  };
}

/**
 * Which agent below the root asks, when one does: the subagent behind the oldest open request,
 * else a subagent or delegated child whose own tree waits on the person. Undefined when the root
 * asks itself. Reads every agent only while the tree waits on the person with no request here.
 */
function askerOf(
  reader: ActivityReader,
  rootId: string,
  interactions: readonly Interaction[],
): string | undefined {
  const first = interactions[0];
  if (first) {
    const agent = first.agentId === rootId ? undefined : reader.agent(first.agentId);
    return agent && agent.origin !== "root" ? agentName(agent) : undefined;
  }
  for (const id of reader.agentIds()) {
    const agent = reader.agent(id);
    if (!agent || agent.origin === "root" || id === rootId) continue;
    if (agent.status.state === "blocked" && agent.status.on === "human") return agentName(agent);
  }
  return undefined;
}

/** The live line for a fact every surface words alike (`live-status.ts`). */
function factLine(fact: LiveFact, tone: ActivityTone): TurnActivity {
  const { label, code } = describeLive(fact, 0);
  return { label, code, tone, elapsedFrom: undefined, current: undefined };
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
  const tree = turnTreeOf(reader);
  const watch = [...tree.watch()];
  const pending = tree.pending();
  const activity = tree.needsYou
    ? waitingOnYou(reader, rootId, pending)
    : readActivity(reader, rootId, options, watch);
  const status = reader.agent(rootId)?.status;
  const waitingCount =
    status?.state === "blocked" && status.on === "subagents" ? status.refs.length : 0;
  const subagents = Math.max(
    tree.subagents,
    reader.thread?.live?.runningSubagentCount ?? 0,
    waitingCount,
  );
  const backgroundCommands = tree.backgroundCommands;
  const stretch = ledgerOf(reader).currentStretch(reader);
  for (const id of stretch.watch) watch.push(`item:${id}`);
  const runId = reader.thread?.live?.rootRunId ?? stretch.runId;
  const run = runId ? reader.run(runId) : undefined;
  if (runId) watch.push(`run:${runId}`);
  // The server's turn start survives snapshots, partial messages and child work outliving it.
  const clock = runId ? tree.clock(runId) : undefined;
  const from =
    clock?.from ??
    stretch.origin ??
    run?.startedAt ??
    reader.thread?.live?.workingSince ??
    stretch.start;
  const root = rootStandOf(activity, status);
  const needsYou = tree.needsYou || activity?.tone === "needs-you";
  // A stopped turn whose agents have all ended has no live line, though commands it started may
  // still run: the composer's strip says so and offers to stop them. The person still comes first.
  const stopped =
    (status?.state === "interrupted" || run?.state === "interrupted") && !subagents && !needsYou;
  const working = !stopped && treeWorking({ needsYou, root, subagents, backgroundCommands });
  const shown = stopped
    ? undefined
    : working
      ? {
          ...activity,
          code: undefined,
          label: options.stopping ? "Stopping…" : "Working",
          tone: "working" as const,
          elapsedFrom:
            from === undefined
              ? undefined
              : from +
                (clock?.idle ?? stretch.idle) +
                ledgerOf(reader).waitedWithin(from, Number.POSITIVE_INFINITY, from),
          // A root held while its tree works names the hold as its step: "Rate limited · …".
          current:
            (root === "held" && activity ? heldText(activity) : undefined) ??
            activity?.current ??
            currentAction(stretch.current, options.labels) ??
            tree.currentCommand(),
          subagents,
          backgroundCommands,
        }
      : activity;
  return { activity: shown, watch: [...new Set(watch)] };
}

/**
 * Whether the root's latest turn was stopped (interrupted rather than finished), with the run
 * and item keys it was read from. A new turn starting clears it.
 */
export function readStoppedTurn(
  reader: ActivityReader,
  rootId: string,
): { stopped: boolean; watch: readonly string[] } {
  const stretch = ledgerOf(reader).currentStretch(reader);
  const runId = reader.thread?.live?.rootRunId ?? stretch.runId;
  const run = runId ? reader.run(runId) : undefined;
  return {
    stopped: reader.agent(rootId)?.status.state === "interrupted" || run?.state === "interrupted",
    watch: [...stretch.watch.map((id) => `item:${id}`), ...(runId ? [`run:${runId}`] : [])],
  };
}

/** A held root's line as its tree's step: the hold and the command it names. */
function heldText(activity: TurnActivity): string {
  return activity.code ? `${activity.label} ${activity.code}` : activity.label;
}

/** Where the root stands under its live line, for the shared `treeWorking` rule. */
function rootStandOf(
  activity: TurnActivity | undefined,
  status: AgentStatus | undefined,
): RootStand {
  if (!activity) return "idle";
  if (activity.tone === "working") return "working";
  if (activity.tone === "held" && status?.state === "blocked" && status.on === "subagents")
    return "on-tree";
  if (activity.tone === "held" && status?.state === "blocked" && status.on === "background_task")
    return "background";
  return "held";
}

function readActivity(
  reader: ActivityReader,
  rootId: string,
  options: ActivityOptions,
  watch: string[],
): TurnActivity | undefined {
  const threadStatus = options.threadStatus ?? reader.thread?.status;
  if (threadStatus?.state === "waiting" && threadStatus.on === "queue") return undefined;
  const agent = reader.agent(rootId);
  const status = agent?.status;
  if (!status) return undefined;
  // Imported history has no live provider until the person sends a new message.
  if (
    reader.thread?.imported &&
    reader.thread.status.state === "new" &&
    (status.state === "starting" || status.state === "unresponsive")
  )
    return undefined;
  const ledger = ledgerOf(reader);
  const pending = [...ledger.pending()];
  const live =
    status.state !== "idle" && status.state !== "interrupted" && status.state !== "failed";
  if (options.stopping && live) return line("Stopping…", "working");
  // Anything the person must answer before the agent can go on: no timer, a needs-you mark.
  const blocking = pending.filter((interaction) => interaction.blocking);
  if (blocking.length && live) return waitingOnYou(reader, rootId, blocking);
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
            stretch.idle +
            ledger.waitedWithin(stretch.start, Number.POSITIVE_INFINITY, stretch.start);
      const current = currentAction(stretch.current, options.labels) ?? status.detail;
      const label =
        activityLabels[status.activity] ??
        (elapsedFrom === undefined && status.activity === "thinking" ? "Thinking" : "Working");
      return { label, tone: "working", elapsedFrom, current };
    }
    case "blocked": {
      if (status.on === "human") return waitingOnYou(reader, rootId, pending);
      if (status.on === "subagents")
        return status.refs.length
          ? factLine({ kind: "subagents", count: status.refs.length }, "working")
          : line("Waiting on subagents", "working");
      if (status.on === "background_task") {
        // Its refs are background tasks and subagents that outlived the turn.
        const titles: string[] = [];
        let agents = 0;
        for (const id of status.refs) {
          const task = reader.task(id);
          if (task) {
            watch.push(`task:${id}`);
            if (!task.ambient) titles.push(task.title);
          } else if (reader.agent(id)) agents++;
        }
        if (!titles.length && agents) return factLine({ kind: "subagents", count: agents }, "held");
        return factLine(
          { kind: "watching", count: Math.max(1, titles.length), title: titles[0] },
          "held",
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
      return pending.length ? waitingOnYou(reader, rootId, pending) : undefined;
  }
}

/** Name a tree's current step the same way while the root works or waits on children. */
function currentAction(item: Item | undefined, labels: StepLabels | undefined): string | undefined {
  if (!item) return undefined;
  if (
    item.type === "tool_call" &&
    item.call.detail.kind === "shell" &&
    isTestCommand(item.call.detail.command)
  )
    return "Running tests…";
  const step = describeStep(item, { labels });
  return [step.verb, step.target].filter(Boolean).join(" ");
}

export function sameActivity(a: TurnActivity | undefined, b: TurnActivity | undefined): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.label === b.label &&
      a.code === b.code &&
      a.tone === b.tone &&
      a.elapsedFrom === b.elapsedFrom &&
      a.current === b.current &&
      a.subagents === b.subagents &&
      a.backgroundCommands === b.backgroundCommands &&
      a.asker === b.asker)
  );
}
