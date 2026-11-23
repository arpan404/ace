/*
 * The fold's edits to its entries (`foldSpade`): placing an entry where it happened, changing a
 * reply, a request or a question card in place, and settling a reply's calls. Each finds what it
 * changes from the end, so it does work in proportion to the change.
 */

import { spadeRemembered } from "./notes.ts";
import type { SpadeStored } from "./wire.ts";

import type {
  SpadeCallState,
  SpadeReplyPart,
  SpadeReplyEnd,
  SpadeReplyEntry,
  SpadeEntry,
  SpadeQuestionCard,
  SpadeRequest,
  SpadeConversationState,
} from "./fold-types.ts";

export function helperEntry(state: SpadeConversationState, job: string) {
  const line = state.entries.find((entry) => entry.kind === "helper" && entry.job === job);
  return line?.kind === "helper" ? line : undefined;
}

/** The note ids a message's fixed context recalled (`- [n_4] …` lines); nothing for none. */
export function recalledOf(context: string | null | undefined): { recalled?: readonly string[] } {
  const ids = [...(context ?? "").matchAll(/^- \[(n_[A-Za-z0-9_-]+)\]/gm)].flatMap((m) =>
    m[1] ? [m[1]] : [],
  );
  return ids.length ? { recalled: [...new Set(ids)] } : {};
}

/** When Spade stored an event, for the entry it makes; nothing when the event had no time. */
export const stamp = (stored: SpadeStored): { at?: number } =>
  stored.at > 0 ? { at: stored.at } : {};

export function steer(state: SpadeConversationState, message: SpadeEntry) {
  const open = state.open;
  const entry = open && state.entries[open.index];
  if (!open || entry?.kind !== "reply") {
    state.entries.push(message);
    return;
  }
  if (entry.parts.length) state.entries[open.index] = { ...entry, live: "" };
  else state.entries.splice(open.index, 1);
  state.entries.push(message, { ...entry, key: `${entry.key}@${message.key}`, parts: [] });
  open.index = state.entries.length - 1;
}

/** A memory tool's result that saved or rewrote a note shows as its one line in the reply. */
export function remembered(
  state: SpadeConversationState,
  reply: string,
  key: string,
  name: string,
  content: unknown,
  isError: boolean,
) {
  const note = spadeRemembered(name, content, isError);
  if (note)
    updateReply(state, reply, (entry) => ({
      ...entry,
      parts: [...entry.parts, { kind: "remembered", key, note }],
    }));
}

/**
 * Change the request for `callId` where it stands, the newest first: a reply's part or an entry
 * of its own. Answers come soon after the ask, so the walk back is short. False when none is.
 */
/** Where card `cardId` stands among the entries, walking back from the newest. */
export function cardAt(state: SpadeConversationState, cardId: string): number | undefined {
  for (let index = state.entries.length - 1; index >= 0; index--) {
    const entry = state.entries[index];
    if (entry?.kind === "card" && entry.cardId === cardId) return index;
  }
  return undefined;
}

export function updateRequest(
  state: SpadeConversationState,
  callId: string,
  change: (request: SpadeRequest) => SpadeRequest,
): boolean {
  return updatePlaced(state, "request", callId, change);
}

/**
 * Change the card for `callId` where it stands, as `updateRequest` does. `change` returns
 * undefined to leave it; true only when the card is there and changed. A deferred card may be
 * answered long after: the walk back goes as far as it is.
 */
export function updateQuestion(
  state: SpadeConversationState,
  callId: string,
  change: (card: SpadeQuestionCard) => SpadeQuestionCard | undefined,
): boolean {
  return updatePlaced(state, "question", callId, change);
}

type Placed = Extract<SpadeEntry, { kind: "request" | "question" }>;

export function updatePlaced<K extends Placed["kind"], T>(
  state: SpadeConversationState,
  kind: K,
  callId: string,
  change: (item: T) => T | undefined,
): boolean {
  const fits = (item: { kind: string; callId?: string }): item is Extract<Placed, { kind: K }> =>
    item.kind === kind && item.callId === callId;
  for (let index = state.entries.length - 1; index >= 0; index--) {
    const entry = state.entries[index];
    if (!entry) continue;
    if (fits(entry)) {
      const next = change(entry as T);
      if (next !== undefined) state.entries[index] = { ...entry, ...next };
      return next !== undefined;
    }
    if (entry.kind !== "reply") continue;
    const at = entry.parts.findIndex(fits);
    const part = entry.parts[at];
    if (!part || !fits(part)) continue;
    const next = change(part as T);
    if (next === undefined) return false;
    state.entries[index] = { ...entry, parts: entry.parts.with(at, { ...part, ...next }) };
    return true;
  }
  return false;
}

/** Replace the open reply's entry when it is `reply`; `change` returns undefined for no change. */
/** Change the open reply's live text; only an open reply streams. */
export function updateOpen(
  state: SpadeConversationState,
  reply: string,
  change: (entry: SpadeReplyEntry) => SpadeReplyEntry | undefined,
): boolean {
  if (state.open?.reply !== reply) return false;
  return changeAt(state, state.open.index, change);
}

/**
 * Where reply `reply` stands: the open reply's place, else its latest part (a steered reply's
 * parts share its id). Steps of a reply that already ended still land in it, by its id.
 */
export function replyAt(state: SpadeConversationState, reply: string): number | undefined {
  if (state.open?.reply === reply) return state.open.index;
  const index = state.entries.findLastIndex(
    (entry) => entry.kind === "reply" && entry.reply === reply,
  );
  return index < 0 ? undefined : index;
}

/** Change reply `reply` by its id, open or not (`replyAt`). */
export function updateReply(
  state: SpadeConversationState,
  reply: string,
  change: (entry: SpadeReplyEntry) => SpadeReplyEntry | undefined,
): boolean {
  const index = replyAt(state, reply);
  return index !== undefined && changeAt(state, index, change);
}

export function changeAt(
  state: SpadeConversationState,
  index: number,
  change: (entry: SpadeReplyEntry) => SpadeReplyEntry | undefined,
): boolean {
  const entry = state.entries[index];
  if (entry?.kind !== "reply") return false;
  const next = change(entry);
  if (!next) return false;
  state.entries[index] = next;
  return true;
}

export function setCall(
  state: SpadeConversationState,
  reply: string,
  callId: string,
  name: string | undefined,
  callState: SpadeCallState,
  /** The event's seq, kept as the call's `logged` when it has none yet. */
  seq?: number,
) {
  // Where the call stands: as the open reply recorded it, or, once its reply ended, found in
  // that reply by its id (a result that arrives late still lands on its own step).
  const index = state.calls.get(callId)?.index ?? callIn(state, reply, callId);
  const entry = index === undefined ? undefined : state.entries[index];
  if (index !== undefined && entry?.kind === "reply") {
    const at = entry.parts.findIndex((part) => part.kind === "call" && part.key === callId);
    const part = entry.parts[at];
    if (part?.kind !== "call") return;
    // `call_tool` reaches a deferred tool; once Spade names that tool, the call reads as it.
    const named = name && part.name === "call_tool" ? name : part.name;
    const logged = part.logged ?? seq;
    // Spade answers a declined call with an errored result; it stays what the person chose. A
    // refused call's result is its refusal, so it stays refused.
    const next =
      part.state === "declined" && callState === "failed"
        ? "declined"
        : part.state === "refused" && (callState === "done" || callState === "failed")
          ? "refused"
          : callState;
    if (part.state === next && named === part.name && logged === part.logged) return;
    const parts = entry.parts.slice();
    parts[at] = {
      ...part,
      name: named,
      state: next,
      ...(logged === undefined ? {} : { logged }),
    };
    state.entries[index] = { ...entry, parts };
    return;
  }
  if (!name) return;
  // A call no step listed (an older Spade): it shows where its reply is now.
  const last = replyAt(state, reply);
  if (last === undefined) return;
  if (state.open?.reply === reply) state.calls.set(callId, { reply, index: last });
  changeAt(state, last, (open) => ({
    ...open,
    parts: [
      ...open.parts,
      {
        kind: "call",
        key: callId,
        name,
        state: callState,
        ...(seq === undefined ? {} : { logged: seq }),
      },
    ],
  }));
}

type CallPart = Extract<SpadeReplyPart, { kind: "call" }>;

/**
 * Change call `callId` of reply `reply` where its step stands (as `setCall` finds it); false when
 * no step lists it or `change` leaves it as it is.
 */
export function patchCall(
  state: SpadeConversationState,
  reply: string,
  callId: string,
  change: (part: CallPart) => CallPart | undefined,
): boolean {
  const index = state.calls.get(callId)?.index ?? callIn(state, reply, callId);
  const entry = index === undefined ? undefined : state.entries[index];
  if (index === undefined || entry?.kind !== "reply") return false;
  const at = entry.parts.findIndex((part) => part.kind === "call" && part.key === callId);
  const part = entry.parts[at];
  if (part?.kind !== "call") return false;
  const next = change(part);
  if (!next) return false;
  state.entries[index] = { ...entry, parts: entry.parts.with(at, next) };
  return true;
}

/** Mark call `callId` refused by the auto-review, with its reason, wherever its step stands. */
export function refuseCall(state: SpadeConversationState, callId: string, reason: string): boolean {
  for (let index = state.entries.length - 1; index >= 0; index--) {
    const entry = state.entries[index];
    if (entry?.kind !== "reply") continue;
    const at = entry.parts.findIndex((part) => part.kind === "call" && part.key === callId);
    const part = entry.parts[at];
    if (part?.kind !== "call") continue;
    state.entries[index] = {
      ...entry,
      parts: entry.parts.with(at, { ...part, state: "refused", reason: reason.trim() }),
    };
    return true;
  }
  return false;
}

/** The part of reply `reply` (a steered reply has several) that lists call `callId`. */
export function callIn(state: SpadeConversationState, reply: string, callId: string) {
  const index = state.entries.findLastIndex(
    (entry) =>
      entry.kind === "reply" &&
      entry.reply === reply &&
      entry.parts.some((part) => part.kind === "call" && part.key === callId),
  );
  return index < 0 ? undefined : index;
}

export const unsettled = new Set<SpadeCallState>(["queued", "waiting", "running"]);

export function setCallAt(state: SpadeConversationState, index: number, callId: string) {
  const entry = state.entries[index];
  if (entry?.kind !== "reply") return;
  const at = entry.parts.findIndex((part) => part.kind === "call" && part.key === callId);
  const part = entry.parts[at];
  if (part?.kind !== "call" || !unsettled.has(part.state)) return;
  const parts = entry.parts.slice();
  parts[at] = { ...part, state: "skipped" };
  state.entries[index] = { ...entry, parts };
}

export function closeReply(
  state: SpadeConversationState,
  reply: string,
  end: SpadeReplyEnd,
  text: string,
  seq: number,
): boolean {
  if (state.open?.reply !== reply) return false;
  closeOpen(state, end, text, seq);
  return true;
}

/** The last words reply `reply` said, in its part at `index` or the parts above it. */
export function lastWords(state: SpadeConversationState, index: number, reply: string) {
  for (let at = index; at >= 0; at--) {
    const entry = state.entries[at];
    if (entry?.kind !== "reply") continue;
    // Another reply above: this one's parts all sit below it.
    if (entry.reply !== reply) return undefined;
    const text = entry.parts.findLast((part) => part.kind === "text");
    if (text) return text;
  }
  return undefined;
}

/**
 * End the open reply. A finished reply's text repeats its last step's, already shown; any other
 * end carries the open step's words, which no step stored.
 */
export function closeOpen(
  state: SpadeConversationState,
  end: SpadeReplyEnd,
  text: string,
  seq?: number,
) {
  const open = state.open;
  if (!open) return;
  const entry = state.entries[open.index];
  if (entry?.kind === "reply") {
    // A steered reply's last words may sit in an earlier part of it, above what steered it.
    const last = lastWords(state, open.index, entry.reply);
    const words = end.kind === "finished" ? (last?.text === text ? "" : text) : text || entry.live;
    const parts: SpadeReplyPart[] = words.trim()
      ? [
          ...entry.parts,
          {
            kind: "text",
            key: `${entry.key}:end`,
            text: words,
            ...(seq === undefined ? {} : { seq }),
          },
        ]
      : entry.parts.slice();
    state.entries[open.index] = { ...entry, parts, live: "", end };
  }
  // A call left without a result when the reply ended never ran.
  for (const [callId, call] of state.calls) {
    if (call.reply !== open.reply) continue;
    setCallAt(state, call.index, callId);
    state.calls.delete(callId);
  }
  // A helper's or a task's approval waits on it, not on the reply that started it (a helper that
  // moved with main's work into a task asks as the task's, ADR 0217 §2a).
  state.approvals = state.approvals.filter(
    (approval) =>
      approval.helper !== undefined || approval.lane !== undefined || approval.reply !== open.reply,
  );
  // A card still waiting when its turn ended can no longer be answered.
  if (state.question?.reply === open.reply) {
    const { callId } = state.question;
    updateQuestion(state, callId, (card) =>
      card.standing === "waiting" ? { ...card, standing: "closed" } : undefined,
    );
    state.question = undefined;
  }
  for (const [callId, call] of state.running)
    if (call.reply === open.reply) state.running.delete(callId);
  state.open = undefined;
}

/**
 * A task lane ended and Spade closed its requests here (`lane_requests_closed`, ADR 0217 §4):
 * exactly the calls it lists, approvals and question cards alike, no more. A deferred card it
 * doesn't list stays answerable (after done, finished or failed its answer reopens the task).
 */
export function closeLaneRequests(
  state: SpadeConversationState,
  calls: readonly string[],
): boolean {
  const closing = new Set(calls);
  const before = state.approvals.length;
  state.approvals = state.approvals.filter((approval) => !closing.has(approval.callId));
  let changed = state.approvals.length !== before;
  for (const callId of closing) {
    state.forLater.delete(callId);
    if (state.question?.callId === callId) state.question = undefined;
    changed =
      updateQuestion(state, callId, (card) =>
        card.standing === "waiting" || card.standing === "deferred"
          ? { ...card, standing: "closed" }
          : undefined,
      ) || changed;
  }
  return changed;
}
