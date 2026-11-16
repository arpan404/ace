import type { SpadeApproval, SpadeConversationState, SpadeEntry } from "./fold.ts";
import type { SpadeDecision } from "./decisions.ts";
import { spadeApprovalSentence, spadeJobsLine, spadeToolWords } from "./words.ts";
import { spadeHelperApprovalSentence } from "./helper-words.ts";
import { spadeSoonestWake, type SpadeWake } from "./wakes.ts";

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
  /** The bot asked the person a card and waits on it (or on their next message). */
  asking: boolean;
  /** Cards left for later, by call id, oldest first (ADR 0154). */
  forLater: readonly string[];
  /** How many questions those cards hold, for "2 questions for later". */
  questionsForLater: number;
  /**
   * The wake it rests on while it sleeps or waits instead of working (ADR 0160): the resting
   * line's. Never done then. Undefined while it works, waits on the person, or has none open.
   */
  resting: SpadeWake | undefined;
  /** Workers' and services' names by id, for the resting line's words. */
  workers: ReadonlyMap<string, string>;
  services: ReadonlyMap<string, string>;
  /** Choices the bot made on the person's behalf (ADR 0165), oldest first. */
  decisions: readonly SpadeDecision[];
}

export function spadeView(state: SpadeConversationState): SpadeView {
  const open = state.open && state.entries[state.open.index];
  const reply = open?.kind === "reply" ? open : undefined;
  const approvals = state.approvals.map((approval) => ({
    ...approval,
    // A helper's call says so: the person answers for the helper, here.
    sentence: approval.helper
      ? spadeHelperApprovalSentence(spadeToolWords(approval.name).base, "Spade")
      : spadeApprovalSentence(approval.name),
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
    status:
      reply !== undefined || state.jobs.size > 0
        ? plainStatus(state.status, [...state.running.values()].at(-1)?.name)
        : undefined,
    approvals,
    asking: state.question !== undefined,
    forLater: [...state.forLater],
    questionsForLater: questionsIn(state.entries, state.forLater),
    resting: resting(state, reply !== undefined, approvals.length > 0),
    workers: state.capabilities.workers,
    services: state.capabilities.services,
    decisions: state.decisions,
  };
}

/**
 * Its wake while it rests, as Spade's roster reads it: waiting on the person beats resting; an
 * open turn waiting out an outage rests while no job runs; otherwise it works while a reply or a
 * job is open, and rests on any wake once nothing is.
 */
function resting(
  state: SpadeConversationState,
  answering: boolean,
  approvals: boolean,
): SpadeWake | undefined {
  const wakes = state.capabilities.wakes;
  if (!wakes.size || approvals || state.question !== undefined || state.jobs.size > 0) return;
  const open = [...wakes.values()];
  if (answering && !open.some((wake) => wake.purpose === "outage")) return;
  return spadeSoonestWake(open);
}

/**
 * A status that names a tool by its raw name ("Using screen act", from a server that doesn't
 * know the tool) reads in the tool's plain words ("Using an app on the screen").
 */
function plainStatus(status: string | undefined, running: string | undefined): string | undefined {
  if (status === undefined || running === undefined || !status.startsWith("Using ")) return status;
  return spadeToolWords(running).doing;
}

/** The questions of the cards `callIds` names, wherever each card stands in the chat. */
function questionsIn(entries: readonly SpadeEntry[], callIds: ReadonlySet<string>): number {
  if (!callIds.size) return 0;
  let count = 0;
  const add = (card: { callId: string; questions: readonly unknown[] }) => {
    if (callIds.has(card.callId)) count += card.questions.length;
  };
  for (const entry of entries)
    if (entry.kind === "question") add(entry);
    else if (entry.kind === "reply")
      for (const part of entry.parts) if (part.kind === "question") add(part);
  return count;
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
