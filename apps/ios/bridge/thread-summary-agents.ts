import type { Agent, Item } from "@ace/protocol";
import {
  forestAgentWords,
  isActivelyRunning,
  modelLabel,
  summaryAgents,
  type AgentForest,
  type SummaryAgentEntry,
  type ThreadWork,
} from "@ace/ui-core";
import type { Preview } from "./agents.ts";

/*
 * The Summary's agents as the phone draws them: who waits on the person, what works, what
 * failed, and what finished folded under one line, sorted by `summaryAgents` and worded by
 * `forestAgentWords`, as the web's Summary tree words its rows. Pure.
 */

export interface SummaryAgentsFacts {
  threadId: string;
  forest: AgentForest;
  works: ReadonlyMap<string, ThreadWork>;
  /** An agent's name as its tree row says it, in the thread it lives in. */
  name(threadId: string, agent: Agent): string;
  /** An item of any thread the tree shows, for a running tool's step and a spawn's outcome. */
  item(threadId: string, id: string): Item | undefined;
}

type Tone = "plain" | "needs-you" | "failed";

export interface SummaryAgentRow {
  key: string;
  /** The thread the agent lives in, and its own delegated thread when it has one here. */
  threadId: string;
  agentId: string;
  childThreadId: string | null;
  name: string;
  provider: string;
  /** "Opus 5.5", empty when unknown. */
  model: string;
  /** What it does, asks, or came back with, in one line. */
  step: string;
  tone: Tone;
  /** The status icon, in the inbox row's set; the tone colours only the icon. */
  icon: { kind: string; tone: string; count: number | null };
  /** Levels in under the rows above it, 0 to 2. */
  indent: number;
  /** The parent it hangs under, by name, where the indent doesn't show it. */
  under: string | null;
  /** The way on for a request: "Answer" or "Review". */
  action: string | null;
  startedAt: number;
  endedAt: number | null;
  /** Its own work runs now: its row counts its running time. */
  ticking: boolean;
}

export interface SummaryAgentsView {
  asks: SummaryAgentRow[];
  working: SummaryAgentRow[];
  failed: SummaryAgentRow[];
  done: SummaryAgentRow[];
  /** "12 done", the fold over the finished rows; null without any. */
  doneWords: string | null;
  /** Finished out of every agent listed, for the header's quiet progress line. */
  progress: { done: number; total: number; words: string };
}

function iconOf(entry: SummaryAgentEntry, unsure: boolean): SummaryAgentRow["icon"] {
  const { node } = entry;
  const doer = node.childRoot ?? node.agent;
  switch (entry.group) {
    case "asks":
      return {
        kind: entry.request?.request.kind === "question" ? "question" : "approve",
        tone: "needs-you",
        count: null,
      };
    case "failed":
      return { kind: "failed", tone: "failed", count: null };
    case "done":
      return { kind: "done", tone: "muted", count: null };
    case "working":
      if (unsure) return { kind: "waiting", tone: "muted", count: null };
      if (!isActivelyRunning(doer) && node.tally.working > 0)
        return { kind: "agents", tone: "waiting", count: node.tally.working };
      return isActivelyRunning(doer) || node.hold
        ? { kind: "working", tone: "working", count: null }
        : { kind: "waiting", tone: "waiting", count: null };
  }
}

function rowOf(entry: SummaryAgentEntry, facts: SummaryAgentsFacts, preview: Preview) {
  const { node } = entry;
  const doer = node.childRoot ?? node.agent;
  const doerThread = node.childRoot ? (node.childThread ?? node.threadId) : node.threadId;
  const status = doer.status;
  const tool =
    status.state === "working" && status.itemId ? facts.item(doerThread, status.itemId) : undefined;
  const spawn = node.agent.spawnedBy ? facts.item(node.threadId, node.agent.spawnedBy) : undefined;
  const words = forestAgentWords(true, node, { request: entry.request, tool, spawn });
  const modelId = node.agent.model ?? doer.model ?? "";
  const asking = entry.group === "asks";
  const step = words.step.charAt(0).toUpperCase() + words.step.slice(1);
  return {
    key: node.key,
    threadId: node.threadId,
    agentId: node.agent.id,
    childThreadId: node.agent.machine ? null : (node.agent.childThreadId ?? null),
    name: preview(facts.name(node.threadId, node.agent), 128),
    provider: node.agent.native.provider,
    model: modelId ? preview(modelLabel(modelId), 64) : "",
    step: preview(step, 256),
    tone: words.tone ?? "plain",
    icon: iconOf(entry, words.unsure),
    indent: entry.indent,
    under: entry.under ? preview(facts.name(entry.under.threadId, entry.under.agent), 128) : null,
    action: asking
      ? entry.request?.request.kind === "approval" || entry.request?.request.kind === "plan_review"
        ? "Review"
        : "Answer"
      : null,
    startedAt: node.agent.createdAt,
    endedAt: node.agent.endedAt ?? null,
    ticking: entry.group === "working" && isActivelyRunning(doer) && !words.unsure,
  } satisfies SummaryAgentRow;
}

/** The phone's agents section; null while the thread's main agent works alone. */
export function summaryAgentsView(
  facts: SummaryAgentsFacts,
  preview: Preview,
): SummaryAgentsView | null {
  const agents = summaryAgents(facts.threadId, facts.forest, facts.works);
  if (!agents) return null;
  const rows = (list: readonly SummaryAgentEntry[]) =>
    list.map((entry) => rowOf(entry, facts, preview));
  const done = rows(agents.done);
  return {
    asks: rows(agents.asks),
    working: rows(agents.working),
    failed: rows(agents.failed),
    done,
    doneWords: done.length ? `${done.length} done` : null,
    progress: {
      done: agents.finished,
      total: agents.total,
      words: `${agents.finished} of ${agents.total} done`,
    },
  };
}
