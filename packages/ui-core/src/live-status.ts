import { pluralCount } from "./counts.ts";
import { treeOnlyWaits } from "@ace/projection";
import type { QueueSnapshot, ThreadRunMetadata, ThreadStatus } from "@ace/protocol";
import { agentName } from "./agents.ts";
import { describeWake } from "./snooze.ts";
import type { Tone } from "./status.ts";
import { formatClock } from "./time.ts";

/*
 * What a thread is actually doing, in words, beyond its state: watching a background command,
 * waiting on its subagents, running tests, waiting for the person's answer, held at a usage
 * limit. One wording for every surface (the transcript's live line, the sidebar row, the
 * header), whether the facts come from the daemon's live hints on the thread list or from a
 * loaded thread. Pure.
 */

export type LiveFact =
  /** A request waits on the person; `request` is what it asks for (an interaction kind). */
  | { kind: "asking"; request: string }
  /** A delegated child (or one further down its tree) waits on the person; `agent` names it. */
  | { kind: "child-asking"; agent: string }
  /** `resumesAt`: the person chose to resume at the reset, and it carries on by itself then. */
  | { kind: "limited"; until: number | undefined; resumesAt?: number | undefined }
  | { kind: "subagents"; count: number }
  /**
   * Background work holds the thread; `title` is the command of a single shell. A `count` of 0
   * is work the thread holds for but doesn't list.
   */
  | { kind: "watching"; count: number; title: string | undefined }
  /**
   * The thread is done and background commands it left running still run (a dev server, ADR
   * 0109); `title` is the command of a single one.
   */
  | { kind: "left-running"; count: number; title: string | undefined }
  | { kind: "tests" };

export interface LiveStatus {
  /** "Waiting for 2 subagents", "Running in background", "Limited until 3:20 PM". */
  label: string;
  /** A command the label names, shown as code after it: "bun run dev:relay". */
  code: string | undefined;
  tone: Tone;
}

const hour = 3_600_000;

/** "Waiting for your approval" / "… your review" / "… your answer", by what is asked. */
export function askingLabel(request: string): string {
  if (request === "approval") return "Waiting for your approval";
  if (request === "plan_review") return "Waiting for your review";
  return "Waiting for your answer";
}

/** "Waiting for 2 subagents"; bare "Waiting for subagents" when the count is unknown. */
export function waitingOnSubagentsLabel(count: number): string {
  return count > 0
    ? `Waiting for ${pluralCount(count, "subagent", "subagents")}`
    : "Waiting for subagents";
}

/** "general assistant needs you": a delegated child's request, answered from its parent. */
export function childAskingLabel(agent: string): string {
  return `${agent} needs you`;
}

/** "Limited until 3:20 PM" (with the day when it is further off), or "Limited". */
export function limitedLabel(until: number | undefined, now: number, locale?: string): string {
  if (until === undefined || until <= now) return "Limited";
  return `Limited until ${until - now < 20 * hour ? formatClock(until, locale) : describeWake(until, now, locale)}`;
}

/** "Resumes at 9:23 PM" (or "Resumes tomorrow 9:23 AM"): a resume at reset the person chose. */
export function resumesLabel(at: number, now: number, locale?: string): string {
  const when = at - now < 20 * hour ? formatClock(at, locale) : describeWake(at, now, locale);
  return /^\d/.test(when) ? `Resumes at ${when}` : `Resumes ${when}`;
}

/** A live fact in words, with its tone. */
export function describeLive(fact: LiveFact, now: number, locale?: string): LiveStatus {
  switch (fact.kind) {
    case "asking":
      return { label: askingLabel(fact.request), code: undefined, tone: "needs-you" };
    case "child-asking":
      return { label: childAskingLabel(fact.agent), code: undefined, tone: "needs-you" };
    case "limited":
      return {
        label:
          fact.resumesAt !== undefined && fact.resumesAt > now
            ? resumesLabel(fact.resumesAt, now, locale)
            : limitedLabel(fact.until, now, locale),
        code: undefined,
        tone: "waiting",
      };
    case "subagents":
      return {
        label: waitingOnSubagentsLabel(fact.count),
        code: undefined,
        tone: "working",
      };
    case "watching":
      return (fact.count === 1 && fact.title) || fact.count === 0
        ? { label: "Running in background", code: fact.title, tone: "background" }
        : {
            label: `Running ${pluralCount(fact.count, "command", "commands")} in background`,
            code: undefined,
            tone: "background",
          };
    case "left-running":
      return fact.count === 1 && fact.title
        ? { label: "Done · still running", code: fact.title, tone: "done" }
        : {
            label: `Done · ${pluralCount(fact.count, "command", "commands")} still running`,
            code: undefined,
            tone: "done",
          };
    case "tests":
      return { label: "Running tests…", code: undefined, tone: "working" };
  }
}

/** The status as one line of text: "Running in background bun run dev:relay". */
export function liveStatusText(status: LiveStatus): string {
  return status.code ? `${status.label} ${status.code}` : status.label;
}

/**
 * How many named background commands are running, by the exact count (`watchingCount`) rather
 * than the names list, which keeps only the newest 8. A thread stored before the count existed
 * has only the list to go by.
 */
export function leftRunningCount(live: ThreadRunMetadata | undefined): number {
  return Math.max(live?.watchingCount ?? 0, live?.watching?.length ?? 0);
}

/**
 * What a listed thread is doing, from its status and the daemon's live hints, when they say
 * more than the status alone. Undefined for a thread that is simply working, done or new.
 */
export function threadLiveFact(thread: {
  status: ThreadStatus;
  live?: ThreadRunMetadata | undefined;
  queue?: Pick<QueueSnapshot, "paused" | "reason" | "resumeAt"> | undefined;
}): LiveFact | undefined {
  const { status, live, queue } = thread;
  switch (status.state) {
    case "needs_you": {
      const request = live?.asking?.[0]?.kind;
      if (request) return { kind: "asking", request };
      const child = live?.askingThreads?.[0];
      return child ? { kind: "child-asking", agent: agentName({ name: child.name }) } : undefined;
    }
    case "limited": {
      // A resume at reset the person chose: the queue holds on the limit with a deadline.
      const resumesAt =
        queue?.paused && queue.reason === "limit" && queue.resumeAt !== null
          ? queue.resumeAt
          : undefined;
      return { kind: "limited", until: status.until, ...(resumesAt ? { resumesAt } : {}) };
    }
    case "working":
      if (live?.waitingOn) return { kind: "subagents", count: live.waitingOn };
      return live?.step === "tests" ? { kind: "tests" } : undefined;
    case "waiting": {
      if (status.on !== "background_task") return undefined;
      // Only shells are named; bookkeeping holds the thread without being counted.
      const watching = live?.watching ?? [];
      const count = Math.max(watching.length, live?.backgroundTaskCount ?? 0);
      return {
        kind: "watching",
        count,
        title: count === 1 && watching.length === 1 ? watching[0]?.title : undefined,
      };
    }
    case "done": {
      // Commands it left running are a quiet fact beside Done, never hidden (ADR 0109).
      const watching = live?.watching ?? [];
      const count = leftRunningCount(live);
      if (!count) return undefined;
      return {
        kind: "left-running",
        count,
        title: count === 1 && watching.length === 1 ? watching[0]?.title : undefined,
      };
    }
    default:
      return undefined;
  }
}

/**
 * Where a thread's root agent stands, for `treeWorking`: working on its own; waiting on its own
 * subagents; its turn over with only background commands running; held by something outside
 * the tree (a usage limit, the network, a provider that stopped answering); or idle (its turn
 * is over, or it waits on queued input).
 */
export type RootStand = "working" | "on-tree" | "background" | "held" | "idle";

/** What every surface knows about a thread's agent tree, read from whatever it has loaded. */
export interface TreeFacts {
  /** Anything in the tree waits on the person. */
  needsYou: boolean;
  root: RootStand;
  /** Subagents still starting, working or waiting on their own. */
  subagents: number;
  /** Background commands still running. */
  backgroundCommands: number;
}

/**
 * The one rule the transcript's live line, the sidebar row and the header's Work dot share:
 * Working means an agent is doing a turn. The tree reads as Working while its root works or
 * waits on its own subagents, or while any subagent still runs, whatever holds the root itself
 * (a finished turn, a usage limit, the network). Background commands alone never make it
 * Working (see `treeInBackground`). A request waiting on the person always outranks it.
 */
export function treeWorking(facts: TreeFacts): boolean {
  if (facts.needsYou) return false;
  if (facts.root === "working" || facts.root === "on-tree") return true;
  return facts.subagents > 0;
}

/**
 * The tree is Working but its root does nothing itself: it waits on its own subagents, or its
 * turn is over while they carry on. Every surface says Waiting then, not Working.
 */
export function treeWaiting(facts: TreeFacts): boolean {
  return treeWorking(facts) && facts.root !== "working" && facts.root !== "held";
}

/**
 * The turn is over and only background commands still run: not Working (no agent is doing a
 * turn) and never Done (something still runs). The person's next message goes straight in.
 */
export function treeInBackground(facts: TreeFacts): boolean {
  return !facts.needsYou && !treeWorking(facts) && facts.backgroundCommands > 0;
}

/** The tree facts a listed thread carries in its status and the daemon's live hints. */
export function listTreeFacts(thread: {
  status: ThreadStatus;
  live?: ThreadRunMetadata | undefined;
}): TreeFacts {
  const { status, live } = thread;
  const subagents = Math.max(live?.runningSubagentCount ?? 0, live?.waitingOn ?? 0);
  const watching =
    status.state === "waiting" && status.on === "background_task"
      ? Math.max(live?.watching?.length ?? 0, live?.backgroundTaskCount ?? 0, 1)
      : 0;
  return {
    needsYou: status.state === "needs_you",
    root: listRootStand(status, live),
    subagents,
    backgroundCommands: watching,
  };
}

/**
 * The root's stand as a listed thread shows it. A working thread whose root waits on its
 * subagents says so (`waitingOn`); one whose working agents are all subagents has a root whose
 * own turn is over.
 */
function listRootStand(status: ThreadStatus, live: ThreadRunMetadata | undefined): RootStand {
  if (status.state === "working") {
    if (live?.waitingOn) return "on-tree";
    if (treeOnlyWaits(status, live)) return "idle";
  }
  return rootStand(status);
}

/**
 * When a running tree's shown status began, for the time beside it: Waiting since the wait on
 * its subagents began, Working since its work began. The sidebar row and the composer's strip
 * both time a status from here, from the daemon's stamps, so a reconnect never moves it.
 */
export function liveStatusSince(
  live: ThreadRunMetadata | undefined,
  waiting: boolean,
): number | undefined {
  return (waiting ? live?.waitingSince : undefined) ?? live?.workingSince;
}

function rootStand(status: ThreadStatus): RootStand {
  switch (status.state) {
    case "working":
      return "working";
    case "waiting":
      if (status.on === "background_task") return "background";
      return status.on === "queue" ? "idle" : "held";
    case "limited":
    case "failed":
    case "unresponsive":
      return "held";
    default:
      return "idle";
  }
}

/** Queue holds are waiting input, with no running provider to stop. */
export function threadIsRunning(status: ThreadStatus | undefined): boolean {
  return (
    status?.state === "working" ||
    status?.state === "needs_you" ||
    status?.state === "unresponsive" ||
    (status?.state === "waiting" && status.on !== "queue" && status.on !== "background_task")
  );
}
