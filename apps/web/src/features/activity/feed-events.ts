import type { ForgePrRef, ForgePrStatus, ThreadListEntry } from "@ace/protocol";

/*
 * Feed events from daemon facts: a thread's linked pull request (`details.linkedPr`, its
 * settlement, and the forge's `pr.status`: checks and comments) and a deck's open decisions.
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
  /** A deck agent's own question or approval: answered in its thread, not by the deck. */
  interaction?: { threadId: string; interactionId: string };
  /** What the item's own page shows: the whole comment, the failing checks, the PR. */
  detail?: FeedDetail;
}

export type FeedDetail =
  | {
      kind: "mention";
      author: string;
      body: string;
      pr: PrRef;
      /** An inline review comment can be answered in its thread on the forge. */
      reply?: { threadId: string; pr: ForgePrRef; commentId: number };
    }
  | { kind: "ci"; checks: { name: string; conclusion: string; url: string | null }[]; pr: PrRef }
  | { kind: "pr"; state: "merged" | "closed"; pr: PrRef };
export interface PrRef {
  number: number;
  title: string;
  /** On the forge; absent when only the thread's link is known. */
  url?: string;
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
  const title = status?.title ?? thread.title;
  return {
    id: `pr:${thread.id}:${thread.pr.number}:${final}`,
    kind: "pr",
    title: `PR #${thread.pr.number} ${final}`,
    project: thread.workspaceId,
    context: title,
    at: thread.settledReason === reason && thread.settledAt ? thread.settledAt : thread.updatedAt,
    threadId: thread.id,
    outcome: "done",
    detail: {
      kind: "pr",
      state: final,
      pr: { number: thread.pr.number, title, ...(status ? { url: status.url } : {}) },
    },
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
    detail: {
      kind: "ci",
      checks: failing.map((check) => ({
        name: check.name,
        conclusion: check.conclusion ?? "failure",
        url: check.url,
      })),
      pr: { number: status.ref.number, title: status.title, url: status.url },
    },
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
      detail: {
        kind: "mention",
        author: comment.author,
        body: comment.body,
        pr: { number: status.ref.number, title: status.title, url: status.url },
        ...(comment.kind === "inline"
          ? { reply: { threadId: thread.id, pr: status.ref, commentId: comment.id } }
          : {}),
      },
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
