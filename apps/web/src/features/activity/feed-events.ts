import type { ForgePrStatus, ThreadListEntry } from "@ace/protocol";

/*
 * Feed events from daemon facts: a thread's linked pull request (`details.linkedPr`, its
 * settlement, and the forge's `pr.status`: checks and comments) and a deck's escalated gate.
 * Pure, so each rule is tested on its own.
 */

export type FeedKind = "escalation" | "mention" | "ci" | "pr";

export interface FeedAction {
  id: "approve" | "reject";
  label: string;
  primary?: boolean;
}
export interface FeedEvent {
  /** Stable across reads, so read state sticks: a new push or comment is a new id. */
  id: string;
  kind: FeedKind;
  title: string;
  /** The project, from the thread or deck. */
  project: string;
  /** The thread or deck title, plus detail ("2 failing"). */
  context: string;
  at: number;
  threadId?: string;
  outcome?: "failed" | "done";
  /** Escalations: the deck's explanation, and the decision it waits on. */
  body?: string;
  actions?: readonly FeedAction[];
  runId?: string;
  gateId?: string;
}

/** The thread fields the feed reads: its linked PR and when the PR settled it. */
export type LinkedThread = Pick<
  ThreadListEntry,
  "id" | "title" | "workspaceId" | "updatedAt" | "settledAt" | "settledReason"
> & { pr: { number: number; state: "open" | "closed" | "merged" } };

const time = (iso: string | null | undefined) => {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(at) ? at : undefined;
};

/** A thread's PR merged or closed: at the settlement the daemon recorded, else its last update. */
function settled(thread: LinkedThread, status: ForgePrStatus | null): FeedEvent | undefined {
  const state = status?.state === "merged" || status?.state === "closed" ? status.state : undefined;
  const final = state ?? (thread.pr.state === "open" ? undefined : thread.pr.state);
  if (!final) return undefined;
  const reason = final === "merged" ? "pr_merged" : "pr_closed";
  return {
    id: `pr:${thread.id}:${thread.pr.number}:${final}`,
    kind: "pr",
    title: `PR #${thread.pr.number} ${final}`,
    project: thread.workspaceId,
    context: status?.title ?? thread.title,
    at: thread.settledReason === reason && thread.settledAt ? thread.settledAt : thread.updatedAt,
    threadId: thread.id,
    outcome: "done",
  };
}

/** Failing checks on the PR's current head: one event per head, so a new push starts over. */
function failedChecks(thread: LinkedThread, status: ForgePrStatus): FeedEvent | undefined {
  const failing = status.checks.filter((check) => check.status === "failure");
  if (status.ci !== "failure" || !failing.length) return undefined;
  const latest = Math.max(...failing.map((check) => time(check.completedAt) ?? 0));
  return {
    id: `ci:${thread.id}:${status.headSha}`,
    kind: "ci",
    title: `Checks failed on #${status.ref.number}`,
    project: thread.workspaceId,
    context: `${status.title} · ${failing.length} failing`,
    at: latest || thread.updatedAt,
    threadId: thread.id,
    outcome: "failed",
  };
}

const mentioned = /(^|\s)@[\w-]+/;
const firstLine = (text: string) => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 140 ? `${line.slice(0, 137).trimEnd()}…` : line;
};

/** Review and conversation comments that @-mention someone; the newest three per PR. */
function mentions(thread: LinkedThread, status: ForgePrStatus): FeedEvent[] {
  return status.comments
    .filter((comment) => mentioned.test(comment.body))
    .toSorted((a, b) => (time(b.updatedAt) ?? 0) - (time(a.updatedAt) ?? 0))
    .slice(0, 3)
    .map((comment) => ({
      id: `mention:${thread.id}:${comment.kind}:${comment.id}`,
      kind: "mention",
      title: `${comment.author}: ${firstLine(comment.body)}`,
      project: thread.workspaceId,
      context: `${status.title} · #${status.ref.number}`,
      at: time(comment.updatedAt) ?? thread.updatedAt,
      threadId: thread.id,
    }));
}

/** Everything a linked PR adds to the feed. `status` is null when the forge couldn't be read. */
export function pullRequestEvents(thread: LinkedThread, status: ForgePrStatus | null): FeedEvent[] {
  return [
    settled(thread, status),
    status ? failedChecks(thread, status) : undefined,
    ...(status ? mentions(thread, status) : []),
  ].filter((event) => event !== undefined);
}
