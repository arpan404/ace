import type { InteractionRequest, LinkedPullRequest, ThreadStatus } from "@ace/protocol";
import {
  forestAsker,
  forestTally,
  type AgentForest,
  type AgentForestNode,
  type ForestTally,
  type ThreadWork,
} from "./agent-forest.ts";
import { pluralCount } from "./counts.ts";
import { firstLine } from "./line-text.ts";
import { formatSpan } from "./time.ts";

/** The Summary's first words: one sentence, one grey line, and the colour only when it matters. */
export interface NowLine {
  say: string;
  sub: string;
  tone: "plain" | "needs-you" | "failed";
  /** The visual lead, e.g. "Working" for "Working · 17m". */
  lead: string;
  /** The muted time after the lead, e.g. "17m". Absent when the headline stands alone. */
  span?: string | undefined;
  /** The accessible phrase without prefix, e.g. "working for 17 minutes". */
  speak: string;
}

export interface NowFacts {
  status: ThreadStatus;
  /** Every agent and command besides the main agent, across delegated threads. */
  tally: ForestTally;
  /** Anything in the tree, the main agent and every root included, still works or waits. */
  live: boolean;
  /** Every thread the tree shows has facts the daemon confirmed (`AgentForest.confirmed`). */
  confirmed: boolean;
  turn?: { startedAt: number; endedAt?: number | undefined; said?: string | undefined } | undefined;
  /** The thread's pull requests, in review first (`summaryPullRequests`). */
  prs: readonly LinkedPullRequest[];
  now: number;
  /** The agent the person is needed by, at any depth: its name and what it asks. */
  asker?: { name: string; root: boolean; request: InteractionRequest | undefined } | undefined;
  /** The main agent's error, when the thread failed. */
  error?: string | undefined;
}

/** What a request asks, in a few words: the question, the approval's title. */
export function askWords(request: InteractionRequest | undefined): string | undefined {
  switch (request?.kind) {
    case "approval":
      return firstLine(request.title);
    case "question":
      return firstLine(request.questions[0]?.text);
    case "plan_review":
      return firstLine(request.title ?? request.summary) ?? "review its plan";
    case "elicitation":
    case "browser_help":
      return firstLine(request.message);
    default:
      return undefined;
  }
}

const needs = (request: InteractionRequest | undefined) => {
  switch (request?.kind) {
    case "approval":
      return "needs your approval";
    case "plan_review":
      return "needs you to review its plan";
    case "browser_help":
      return "needs you in the browser";
    default:
      return "needs your answer";
  }
};

const waits: Record<Extract<ThreadStatus, { state: "waiting" }>["on"], string> = {
  background_task: "",
  rate_limit: "Waiting on the provider's rate limit",
  network: "Waiting for the network",
  upstream: "Waiting on the provider",
  queue: "Queued",
};

function work(tally: ForestTally): string {
  const words: string[] = [];
  if (tally.working) words.push(`${pluralCount(tally.working, "agent")} working`);
  if (tally.done) words.push(`${tally.done} done`);
  if (tally.syncing) words.push(`${tally.syncing} syncing`);
  if (tally.commands) words.push(`${pluralCount(tally.commands, "command")} running`);
  return words.join(" · ");
}

/** "#1544 is ready for review", "#1544 merged": the newest pull request, as an outcome. */
function prOutcome(prs: readonly LinkedPullRequest[]): string | undefined {
  const pr = prs[0];
  if (!pr) return undefined;
  if (pr.state === "open") return `#${pr.number} is ready for review`;
  if (pr.state === "draft") return `#${pr.number} is a draft`;
  if (pr.state === "merged") return `#${pr.number} merged`;
  return undefined;
}

/** "17 minutes", "1 hour 12 minutes": a span in words for the accessible name. */
function formatSpanWords(from: number, to: number): string {
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourWords = `${hours} ${hours === 1 ? "hour" : "hours"}`;
  if (!rest) return hourWords;
  return `${hourWords} ${rest} ${rest === 1 ? "minute" : "minutes"}`;
}

const lowerFirst = (sentence: string): string =>
  sentence.length ? `${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}` : sentence;

/**
 * The thread now, in one short line: who needs what, how long it has worked, or how long it
 * took and what came of it. The visual line keeps the time after a middle dot ("Working · 17m",
 * "Done · 52m"); the accessible phrase says it in full ("working for 17 minutes"). Pure: the
 * clock is `now`.
 */
export function nowLine(facts: NowFacts): NowLine {
  const { status, tally, turn } = facts;
  if (facts.asker) {
    const who = facts.asker.root ? "The main agent" : facts.asker.name;
    const ask = askWords(facts.asker.request);
    const say = `${who} ${needs(facts.asker.request)}`;
    return {
      say,
      sub: ask ? `Asks: ${ask}` : "",
      tone: "needs-you",
      lead: say,
      speak: say,
    };
  }
  if (status.state === "needs_you")
    return {
      say: "Needs your answer",
      sub: work(tally),
      tone: "needs-you",
      lead: "Needs your answer",
      speak: "needs your answer",
    };
  if (status.state === "failed")
    return {
      say: "Failed",
      sub: firstLine(facts.error) ?? work(tally),
      tone: "failed",
      lead: "Failed",
      speak: "failed",
    };
  if (status.state === "unresponsive")
    return {
      say: "The provider stopped responding",
      sub: work(tally),
      tone: "failed",
      lead: "The provider stopped responding",
      speak: "the provider stopped responding",
    };
  if (status.state === "new")
    return {
      say: "Nothing has run yet",
      sub: "",
      tone: "plain",
      lead: "Nothing has run yet",
      speak: "nothing has run yet",
    };
  if (status.state === "limited")
    return {
      say: "Paused at the usage limit",
      sub: work(tally),
      tone: "plain",
      lead: "Paused at the usage limit",
      speak: "paused at the usage limit",
    };
  if (status.state === "working" || status.state === "waiting") {
    const waiting = status.state === "waiting" ? waits[status.on] : "";
    if (waiting)
      return {
        say: waiting,
        sub: work(tally),
        tone: "plain",
        lead: waiting,
        speak: lowerFirst(waiting),
      };
    const since = turn && turn.endedAt === undefined ? turn.startedAt : undefined;
    if (since === undefined)
      return { say: "Working", sub: work(tally), tone: "plain", lead: "Working", speak: "working" };
    const span = formatSpan(since, Math.max(since, facts.now));
    return {
      say: `Working · ${span}`,
      sub: work(tally),
      tone: "plain",
      lead: "Working",
      span,
      speak: `working for ${formatSpanWords(since, Math.max(since, facts.now))}`,
    };
  }
  // The thread's own status may say done while a delegated grandchild still works, or before a
  // kept copy is confirmed: done is said only once nothing anywhere is live or unconfirmed.
  if (facts.live)
    return { say: "Working", sub: work(tally), tone: "plain", lead: "Working", speak: "working" };
  if (!facts.confirmed)
    return { say: "Syncing", sub: work(tally), tone: "plain", lead: "Syncing", speak: "syncing" };
  // Done: how long the last turn took, then what came of it.
  const outcome = [
    prOutcome(facts.prs),
    tally.done ? `${pluralCount(tally.done, "agent")} finished` : undefined,
  ].filter(Boolean);
  const said = turn?.said?.replace(/\s+/g, " ").trim();
  const sub = outcome.length ? outcome.join(" · ") : (said ?? "");
  if (turn?.endedAt === undefined)
    return { say: "Done", sub, tone: "plain", lead: "Done", speak: "done" };
  const span = formatSpan(turn.startedAt, turn.endedAt);
  return {
    say: `Done · ${span}`,
    sub,
    tone: "plain",
    lead: "Done",
    span,
    speak: `done in ${formatSpanWords(turn.startedAt, turn.endedAt)}`,
  };
}

/** What Now counts from the tree: every row but the main agent's, and whether any is live. */
export function forestNow(
  forest: Pick<AgentForest, "roots" | "confirmed">,
): Pick<NowFacts, "tally" | "live" | "confirmed"> {
  const [main, ...rest] = forest.roots;
  const tally = forestTally(rest);
  if (main) {
    const below = main.kind === "agent" ? main.tally : forestTally([main]);
    tally.working += below.working;
    tally.done += below.done;
    tally.syncing += below.syncing;
    tally.commands += below.commands;
  }
  return {
    tally,
    live: forest.roots.some((root) => root.live),
    confirmed: forest.confirmed,
  };
}

/** Where Open goes for an asker: its row in its own thread, and the thread it delegated to. */
export interface AskerTarget {
  threadId: string;
  agentId: string;
  childThreadId: string | undefined;
}

/**
 * Who Now names as needing the person: the deepest agent on the first branch that waits, what it
 * asks (its own request or, for a delegate, its thread's main agent's), whether it is the viewed
 * thread's own main agent, and where Open goes when it isn't.
 */
export function summaryAsker(
  threadId: string,
  forest: Pick<AgentForest, "roots">,
  works: ReadonlyMap<string, Pick<ThreadWork, "interactions">>,
):
  | {
      node: AgentForestNode;
      root: boolean;
      request: InteractionRequest | undefined;
      open: AskerTarget | undefined;
    }
  | undefined {
  const node = forestAsker(forest.roots);
  if (!node) return undefined;
  const pending = (thread: string, agent: string) =>
    works.get(thread)?.interactions.find((interaction) => interaction.agentId === agent);
  const own = pending(node.threadId, node.agent.id);
  const delegated =
    own || !node.childThread || !node.childRoot
      ? undefined
      : pending(node.childThread, node.childRoot.id);
  const root = node.agent.origin === "root" && node.threadId === threadId;
  return {
    node,
    root,
    request: (own ?? delegated)?.request,
    open: root
      ? undefined
      : {
          threadId: node.threadId,
          agentId: node.agent.id,
          childThreadId: node.agent.machine ? undefined : node.agent.childThreadId,
        },
  };
}

/** The main agent's error, once it failed: what Now says under "Failed". */
export function mainAgentError(forest: Pick<AgentForest, "roots">): string | undefined {
  const main = forest.roots[0];
  return main?.kind === "agent" && main.agent.status.state === "failed"
    ? main.agent.status.error.message
    : undefined;
}
