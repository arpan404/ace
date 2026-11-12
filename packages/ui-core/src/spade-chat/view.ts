import type { SpadeApproval, SpadeConversationState, SpadeEntry } from "./fold.ts";
import { spadeApprovalSentence, spadeJobsLine, spadeToolWords } from "./words.ts";

/** The conversation's Working line: what runs, in words, and since when. */
export interface SpadeWorking {
  label: string;
  /** When the open reply began; undefined for a job that runs between replies. */
  since: number | undefined;
  /** False while Spade waits on the person rather than working itself. */
  moving: boolean;
}

export interface SpadeView {
  title: string;
  loaded: boolean;
  /** Everything stored so far is shown; anything after is new. */
  caughtUp: boolean;
  /** Stored entries, then messages sent from here that Spade hasn't stored yet. */
  entries: readonly SpadeEntry[];
  /** A reply is open: Stop is offered and a message steers it. */
  answering: boolean;
  /** Anything is still open: a reply, a tool, an approval or a background job. Never done then. */
  busy: boolean;
  working: SpadeWorking | undefined;
  /** The agent's own few words on what it does now, while it works (ADR 0127). */
  status: string | undefined;
  /** Approvals waiting on the person, oldest first, each with its sentence. */
  approvals: readonly (SpadeApproval & { sentence: string })[];
  /** The bot asked the person a question and waits for their next message. */
  asking: boolean;
}

export function spadeView(state: SpadeConversationState): SpadeView {
  const open = state.open && state.entries[state.open.index];
  const reply = open?.kind === "reply" ? open : undefined;
  const approvals = state.approvals.map((approval) => ({
    ...approval,
    sentence: spadeApprovalSentence(approval.name),
  }));
  const pending: SpadeEntry[] = state.pending.map((message) => ({
    kind: "user",
    key: message.key,
    text: message.text,
    images: message.images,
    ...(message.documents ? { documents: message.documents } : {}),
    ...(message.voice ? { voice: message.voice } : {}),
    pending: true,
  }));
  return {
    title: state.title,
    loaded: state.loaded,
    caughtUp: state.caughtUp,
    // A new array each time: the fold changes its own in place, and a view is a snapshot.
    entries: [...state.entries, ...pending],
    answering: reply !== undefined,
    busy:
      reply !== undefined || approvals.length > 0 || state.running.size > 0 || state.jobs.size > 0,
    working: working(state, reply?.startedAt, approvals.length > 0 || state.question !== undefined),
    // Its words only while anything is open: the line goes when the reply ends.
    status: reply !== undefined || state.jobs.size > 0 ? state.status : undefined,
    approvals,
    asking: state.question !== undefined,
  };
}

function working(
  state: SpadeConversationState,
  since: number | undefined,
  waiting: boolean,
): SpadeWorking | undefined {
  const jobs = [...state.jobs.values()];
  if (since === undefined)
    return jobs.length ? { label: spadeJobsLine(jobs), since: undefined, moving: true } : undefined;
  const tool = [...state.running.values()].at(-1);
  if (tool) return { label: spadeToolWords(tool.name).doing, since, moving: true };
  if (waiting) return { label: "Waiting for you", since, moving: false };
  if (jobs.length) return { label: spadeJobsLine(jobs), since, moving: true };
  return { label: "Working", since, moving: true };
}
