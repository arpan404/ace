import {
  spadeCriteriaMarks,
  spadeDecisionsShown,
  spadeGoalHeading,
  spadeGoalShown,
  spadeMoney,
  spadePlanRows,
  spadeQuoted,
  spadeToolWords,
  spadeWorkerRows,
  spadeWorkersSpend,
  type SpadeDecision,
  type SpadeEntry,
  type SpadeEvidence,
  type SpadePlanMark,
  type SpadeTask,
  type SpadeWorkerNode,
  type SpadeWorkerTone,
} from "@ace/ui-core/spade-chat";
import { utf8Bytes } from "./spade-profile.ts";

/*
 * A bot's Work tab on the iPhone (ADR 0159, 0161, 0165), as web's: the goal it works toward with
 * each criterion's verdict and the plan with the evidence it collected, each piece saying where
 * in the conversation it came from; then the workers it runs, and the choices it made for the
 * person, each with the words Change quotes into the composer. The goal and the tree are read
 * from Spade; the decisions and each call's words come from the open conversation, as web's do.
 * Pure: the reads come in, the tab's rows go out, held to one frame.
 */

/** The most each list carries; the rest stay on the computer. */
const most = { plan: 40, criteria: 20, workers: 30, decisions: 20, evidence: 6 };
const lineMax = 280;
/** What the tab may weigh in UTF-8, leaving the rest of a 32 KiB frame for its envelope. */
export const spadeWorkBudget = 30_000;

const clip = (text: string) => {
  const chars = Array.from(text);
  return chars.length <= lineMax ? text : `${chars.slice(0, lineMax - 1).join("")}…`;
};

export interface SpadeWorkEvidenceRow {
  kind: SpadeEvidence["kind"];
  /** A command's own line, else what the tool did; a file's path; a link's address. */
  words: string;
  /** For a command's output: when the reply that ran it began, in ms; null when it isn't shown. */
  at: number | null;
}

export interface SpadeWorkPlanRow {
  text: string;
  depth: number;
  mark: SpadePlanMark;
  /** "Not yet: …" from the check that reopened it, or what it waits on. */
  note: { tone: "not-yet" | "waiting"; text: string } | null;
  evidence: SpadeWorkEvidenceRow[];
}

export interface SpadeWorkGoalRow {
  title: string;
  /** The person's own words the goal came from. */
  text: string;
  /** "Checking", "Not yet", "Done" or the verified count; empty when there is nothing to say. */
  heading: string;
  done: boolean;
  criteria: { text: string; met: boolean; why: string | null }[];
  /** The check couldn't run, once. */
  note: string | null;
  plan: SpadeWorkPlanRow[];
  more: number;
}

export interface SpadeWorkWorkerRow {
  id: string;
  name: string;
  kind: SpadeWorkerNode["kind"];
  depth: number;
  line: string;
  tone: SpadeWorkerTone;
  /** Its own spend, plain; null for ace agents and before it spent anything. */
  spend: string | null;
  /** A bot worker's conversation, which a tap opens; null otherwise. */
  conversation: string | null;
  /** An ace agent's thread; null otherwise. */
  thread: string | null;
}

export interface SpadeWorkDecisionRow {
  id: string;
  choice: string;
  reason: string;
  /** When it was stored, in ms. */
  at: number;
  /** The words Change puts in the composer: the choice, quoted. */
  quote: string;
}

export interface SpadeProfileWork {
  goal: SpadeWorkGoalRow | null;
  workers: SpadeWorkWorkerRow[];
  /** Spend across every worker, plain; null before any. */
  spend: string | null;
  decisions: SpadeWorkDecisionRow[];
  /** The bot works: the tab reads again sooner. */
  moving: boolean;
}

/** What the open conversation says of the bot's calls and decisions; nothing when it is closed. */
export interface SpadeWorkConversation {
  entries: readonly SpadeEntry[];
  decisions: readonly SpadeDecision[];
}

/** Each call in the conversation by id: its tool, its one line and when its reply began. */
function callsIn(entries: readonly SpadeEntry[]) {
  const calls = new Map<string, { name: string; detail: string | undefined; at: number }>();
  for (const entry of entries) {
    if (entry.kind !== "reply") continue;
    for (const part of entry.parts)
      if (part.kind === "call")
        calls.set(part.key, { name: part.name, detail: part.detail, at: entry.startedAt });
  }
  return calls;
}

function evidenceRow(
  evidence: SpadeEvidence,
  calls: ReturnType<typeof callsIn>,
): SpadeWorkEvidenceRow {
  if (evidence.kind === "file") return { kind: "file", words: clip(evidence.path), at: null };
  if (evidence.kind === "url")
    return { kind: "url", words: clip(evidence.url.replace(/^https?:\/\//, "")), at: null };
  const call = calls.get(evidence.call);
  const words = call ? (call.detail ?? spadeToolWords(call.name).done) : "A command's output";
  return { kind: "output", words: clip(words), at: call?.at ?? null };
}

function goalRow(task: SpadeTask, calls: ReturnType<typeof callsIn>): SpadeWorkGoalRow {
  const { criteria, note } = spadeCriteriaMarks(task);
  const plan = spadePlanRows(task.items);
  return {
    title: clip(task.goal.title),
    text: clip(task.goal.text),
    heading: spadeGoalHeading(task.progress),
    done: task.progress.state === "done",
    criteria: criteria.slice(0, most.criteria).map((criterion) => ({
      text: clip(criterion.text),
      met: criterion.met,
      why: criterion.why ? clip(criterion.why) : null,
    })),
    note: note ?? null,
    plan: plan.slice(0, most.plan).map((row) => ({
      text: clip(row.item.text),
      depth: Math.min(row.depth, 4),
      mark: row.mark,
      note: row.note ? { tone: row.note.tone, text: clip(row.note.text) } : null,
      evidence: row.item.evidence
        .slice(0, most.evidence)
        .map((evidence) => evidenceRow(evidence, calls)),
    })),
    more: Math.max(0, plan.length - most.plan),
  };
}

export function spadeProfileWork(
  task: SpadeTask | null | undefined,
  tree: SpadeWorkerNode | undefined,
  conversation: SpadeWorkConversation | undefined,
  moving: boolean,
): SpadeProfileWork {
  const calls = callsIn(conversation?.entries ?? []);
  const spend = spadeWorkersSpend(tree);
  const work: SpadeProfileWork = {
    goal: spadeGoalShown(task) ? goalRow(task, calls) : null,
    workers: spadeWorkerRows(tree)
      .slice(0, most.workers)
      .map((row) => ({
        id: row.node.id,
        name: clip(row.node.name),
        kind: row.node.kind,
        depth: Math.min(row.depth, 4),
        line: clip(row.line),
        tone: row.tone,
        spend: row.spendMicros === undefined ? null : spadeMoney(row.spendMicros),
        conversation: row.node.kind === "bot" ? (row.node.conversation ?? null) : null,
        thread: row.node.kind === "ace" ? row.node.id : null,
      })),
    spend: spend > 0 ? spadeMoney(spend) : null,
    decisions: spadeDecisionsShown(conversation?.decisions ?? [])
      .slice(0, most.decisions)
      .map((decision) => ({
        id: decision.id,
        choice: clip(decision.choice),
        reason: clip(decision.reason),
        at: decision.at,
        quote: spadeQuoted(clip(decision.choice), ""),
      })),
    moving,
  };
  return fit(work);
}

/** Drops the last of the longest list until the tab fits one frame. */
function fit(work: SpadeProfileWork): SpadeProfileWork {
  while (utf8Bytes(JSON.stringify(work)) > spadeWorkBudget) {
    const lists: unknown[][] = [work.workers, work.decisions, work.goal?.plan ?? []];
    const longest = lists.reduce((a, b) => (b.length > a.length ? b : a));
    if (longest.length === 0) break;
    longest.pop();
    if (longest === work.goal?.plan) work.goal.more++;
  }
  return work;
}
