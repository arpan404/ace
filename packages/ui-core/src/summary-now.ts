import type { InteractionRequest, LinkedPullRequest, ThreadStatus } from "@ace/protocol";
import { forestTally, type AgentForest, type ForestTally } from "./agent-forest.ts";
import { pluralCount } from "./counts.ts";
import { firstLine } from "./line-text.ts";
import { formatSpan } from "./time.ts";

/** The Summary's first words: one sentence, one grey line, and the colour only when it matters. */
export interface NowLine {
  say: string;
  sub: string;
  tone: "plain" | "needs-you" | "failed";
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

/**
 * The thread now, in one sentence: who needs what, how long it has worked, or how long it took
 * and what came of it. Pure: the clock is `now`.
 */
export function nowLine(facts: NowFacts): NowLine {
  const { status, tally, turn } = facts;
  if (facts.asker) {
    const who = facts.asker.root ? "The main agent" : facts.asker.name;
    const ask = askWords(facts.asker.request);
    return {
      say: `${who} ${needs(facts.asker.request)}`,
      sub: ask ? `Asks: ${ask}` : "",
      tone: "needs-you",
    };
  }
  if (status.state === "needs_you")
    return { say: "Needs your answer", sub: work(tally), tone: "needs-you" };
  if (status.state === "failed")
    return { say: "Failed", sub: firstLine(facts.error) ?? work(tally), tone: "failed" };
  if (status.state === "unresponsive")
    return { say: "The provider stopped responding", sub: work(tally), tone: "failed" };
  if (status.state === "new") return { say: "Nothing has run yet", sub: "", tone: "plain" };
  if (status.state === "limited")
    return { say: "Paused at the usage limit", sub: work(tally), tone: "plain" };
  if (status.state === "working" || status.state === "waiting") {
    const waiting = status.state === "waiting" ? waits[status.on] : "";
    const since = turn && turn.endedAt === undefined ? turn.startedAt : undefined;
    const say =
      waiting ||
      (since === undefined
        ? "Working"
        : `Working for ${formatSpan(since, Math.max(since, facts.now))}`);
    return { say, sub: work(tally), tone: "plain" };
  }
  // The thread's own status may say done while a delegated grandchild still works, or before a
  // kept copy is confirmed: done is said only once nothing anywhere is live or unconfirmed.
  if (facts.live) return { say: "Working", sub: work(tally), tone: "plain" };
  if (!facts.confirmed) return { say: "Syncing", sub: work(tally), tone: "plain" };
  // Done: how long the last turn took, then what came of it.
  const took =
    turn?.endedAt !== undefined ? `Done in ${formatSpan(turn.startedAt, turn.endedAt)}` : "Done";
  const outcome = [
    prOutcome(facts.prs),
    tally.done ? `${pluralCount(tally.done, "agent")} finished` : undefined,
  ].filter(Boolean);
  const said = turn?.said?.replace(/\s+/g, " ").trim();
  return {
    say: took,
    sub: outcome.length ? outcome.join(" · ") : (said ?? ""),
    tone: "plain",
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
    tally.commands += below.commands;
  }
  return {
    tally,
    live: forest.roots.some((root) => root.live),
    confirmed: forest.confirmed,
  };
}
