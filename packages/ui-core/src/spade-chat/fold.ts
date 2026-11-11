import type { SpadeImageRef, SpadeKnownEvent, SpadeLiveInput, SpadeStored } from "./wire.ts";

/*
 * A Spade conversation as the person sees it, folded from its stored events and live frames
 * (spade/docs/chat-core.md, harness.md). Pure: no I/O, no clock. Each input does work in
 * proportion to itself: entries are replaced one at a time, never rebuilt from history.
 */

/** How one tool call stands. */
export type SpadeCallState =
  | "queued"
  | "waiting"
  | "running"
  | "done"
  | "failed"
  | "declined"
  /** The reply ended before the call had a result. */
  | "skipped";

export type SpadeReplyPart =
  | { kind: "text"; key: string; text: string }
  | { kind: "call"; key: string; name: string; state: SpadeCallState };

export type SpadeReplyEnd =
  | { kind: "finished" }
  | { kind: "stopped" }
  | { kind: "failed"; error: string }
  | { kind: "interrupted" };

export interface SpadeReplyEntry {
  kind: "reply";
  key: string;
  /** Each model step's words and calls, in order. */
  parts: readonly SpadeReplyPart[];
  /** The open step's words so far: checkpoints, then live pieces. Empty once it is stored. */
  live: string;
  /** Undefined while the reply is open. */
  end: SpadeReplyEnd | undefined;
  startedAt: number;
}

export type SpadeEntry =
  | {
      kind: "user";
      key: string;
      text: string;
      images: readonly SpadeImageRef[];
      pending?: true;
    }
  | SpadeReplyEntry
  /** The model now reads a summary of what came before. */
  | { kind: "compacted"; key: string }
  /** A background job ended; its result went to Spade. */
  | { kind: "job"; key: string; name: string; failed: boolean };

export interface SpadeApproval {
  reply: string;
  callId: string;
  name: string;
  arguments: unknown;
}

export interface SpadeConversationState {
  /** The highest `seq` folded; a stored event at or below it is a duplicate. */
  lastSeq: number;
  /** At least one stored event has arrived. */
  loaded: boolean;
  /** The live stream has sent everything stored so far; later events are new. */
  caughtUp: boolean;
  title: string;
  entries: SpadeEntry[];
  /** Messages sent from here that Spade hasn't stored yet. */
  pending: { key: string; text: string; images: readonly SpadeImageRef[] }[];
  /** The open reply's id and its entry's index. */
  open: { reply: string; index: number } | undefined;
  /** Where each call of the open reply is shown: its entry's index. */
  calls: Map<string, { reply: string; index: number }>;
  /** Running tool calls by call id. */
  running: Map<string, { reply: string; name: string }>;
  approvals: SpadeApproval[];
  /** Background jobs still running, by job id. */
  jobs: Map<string, string>;
  /** Stored events of types this client doesn't read, kept count of and otherwise ignored. */
  unknown: number;
}

export type SpadeFoldInput =
  | SpadeLiveInput
  /** The person sent `text`; it shows at once and stays until Spade stores it or refuses it. */
  | { kind: "sent"; key: string; text: string; images?: readonly SpadeImageRef[] }
  | { kind: "refused"; key: string };

export function emptySpadeConversation(): SpadeConversationState {
  return {
    lastSeq: 0,
    loaded: false,
    caughtUp: false,
    title: "",
    entries: [],
    pending: [],
    open: undefined,
    calls: new Map(),
    running: new Map(),
    approvals: [],
    jobs: new Map(),
    unknown: 0,
  };
}

/** Apply one input. Returns whether anything the person sees changed. */
export function foldSpade(state: SpadeConversationState, input: SpadeFoldInput): boolean {
  switch (input.kind) {
    case "stored":
      return foldStored(state, input.stored);
    case "snapshot":
      return updateOpen(state, input.reply, (entry) =>
        entry.live === input.text ? undefined : { ...entry, live: input.text },
      );
    case "delta":
      return updateOpen(state, input.reply, (entry) =>
        input.text ? { ...entry, live: entry.live + input.text } : undefined,
      );
    case "sent":
      state.pending = [
        ...state.pending,
        { key: input.key, text: input.text, images: input.images ?? [] },
      ];
      return true;
    case "caught_up": {
      const changed = !state.caughtUp || !state.loaded;
      state.caughtUp = true;
      state.loaded = true;
      return changed;
    }
    case "refused": {
      const before = state.pending.length;
      state.pending = state.pending.filter((message) => message.key !== input.key);
      return state.pending.length !== before;
    }
  }
}

function foldStored(state: SpadeConversationState, stored: SpadeStored): boolean {
  if (stored.seq <= state.lastSeq) return false;
  state.lastSeq = stored.seq;
  const firstLoad = !state.loaded;
  state.loaded = true;
  const { event } = stored;
  if (event.type === "unknown") {
    state.unknown++;
    return firstLoad;
  }
  return foldKnown(state, event, stored) || firstLoad;
}

function foldKnown(state: SpadeConversationState, event: SpadeKnownEvent, stored: SpadeStored) {
  const key = `s${stored.seq}`;
  switch (event.type) {
    case "user_message": {
      const mine = state.pending.findIndex(
        (message) => message.text === event.text && sameImages(message.images, event.images),
      );
      if (mine >= 0) state.pending = state.pending.filter((_, index) => index !== mine);
      steer(state, { kind: "user", key, text: event.text, images: event.images });
      return true;
    }
    case "reply_started":
      // At most one reply is open; a new one means the last closed without our seeing it.
      if (state.open) closeOpen(state, { kind: "interrupted" }, "");
      state.entries.push({
        kind: "reply",
        key: event.reply,
        parts: [],
        live: "",
        end: undefined,
        startedAt: stored.at,
      });
      state.open = { reply: event.reply, index: state.entries.length - 1 };
      return true;
    case "reply_progress":
      // A checkpoint is never newer than the live pieces that already extend it.
      return updateOpen(state, event.reply, (entry) =>
        entry.live.startsWith(event.text) ? undefined : { ...entry, live: event.text },
      );
    case "step_finished":
      if (state.open?.reply === event.reply)
        for (const call of event.calls)
          state.calls.set(call.id, { reply: event.reply, index: state.open.index });
      return updateOpen(state, event.reply, (entry) => ({
        ...entry,
        live: "",
        parts: [
          ...entry.parts,
          ...(event.text.trim() ? [{ kind: "text" as const, key, text: event.text }] : []),
          ...event.calls.map((call) => ({
            kind: "call" as const,
            key: call.id,
            name: call.name,
            state: "queued" as const,
          })),
        ],
      }));
    case "approval_requested":
      state.approvals = [
        ...state.approvals.filter((approval) => approval.callId !== event.call_id),
        { reply: event.reply, callId: event.call_id, name: event.name, arguments: event.arguments },
      ];
      setCall(state, event.reply, event.call_id, event.name, "waiting");
      return true;
    case "approval_answered":
      state.approvals = state.approvals.filter((approval) => approval.callId !== event.call_id);
      if (!event.allowed) setCall(state, event.reply, event.call_id, undefined, "declined");
      return true;
    case "tool_started":
      state.running.set(event.call_id, { reply: event.reply, name: event.name });
      setCall(state, event.reply, event.call_id, event.name, "running");
      return true;
    case "tool_finished":
      state.running.delete(event.call_id);
      setCall(state, event.reply, event.call_id, event.name, event.is_error ? "failed" : "done");
      return true;
    case "job_started":
      state.jobs.set(event.job, event.name);
      return true;
    case "job_finished":
      state.jobs.delete(event.job);
      state.entries.push({ kind: "job", key, name: event.name, failed: event.is_error === true });
      return true;
    case "reply_finished":
      return closeReply(state, event.reply, { kind: "finished" }, event.text);
    case "reply_stopped":
      return closeReply(state, event.reply, { kind: "stopped" }, event.text);
    case "reply_failed":
      return closeReply(state, event.reply, { kind: "failed", error: event.error }, event.text);
    case "reply_interrupted":
      return closeReply(state, event.reply, { kind: "interrupted" }, event.text);
    case "context_compacted":
      state.entries.push({ kind: "compacted", key });
      return true;
    // Stop's own record: the reply's end and the jobs' ends that follow it say what happened.
    case "stop_requested":
      return false;
    case "renamed":
      if (state.title === event.title) return false;
      state.title = event.title;
      return true;
  }
}

const sameImages = (a: readonly SpadeImageRef[], b: readonly SpadeImageRef[]) =>
  a.length === b.length && a.every((image, index) => image.sha256 === b[index]?.sha256);

/**
 * A message while a reply is open steers it: the reply carries on under the message, so what
 * Spade says next reads after it. The open step's words so far move down with it.
 */
function steer(state: SpadeConversationState, message: SpadeEntry) {
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

/** Replace the open reply's entry when it is `reply`; `change` returns undefined for no change. */
function updateOpen(
  state: SpadeConversationState,
  reply: string,
  change: (entry: SpadeReplyEntry) => SpadeReplyEntry | undefined,
): boolean {
  if (state.open?.reply !== reply) return false;
  const entry = state.entries[state.open.index];
  if (entry?.kind !== "reply") return false;
  const next = change(entry);
  if (!next) return false;
  state.entries[state.open.index] = next;
  return true;
}

function setCall(
  state: SpadeConversationState,
  reply: string,
  callId: string,
  name: string | undefined,
  callState: SpadeCallState,
) {
  if (state.open?.reply !== reply) return;
  const at = state.calls.get(callId);
  const entry = at && state.entries[at.index];
  if (at && entry?.kind === "reply") {
    const index = entry.parts.findIndex((part) => part.kind === "call" && part.key === callId);
    const part = entry.parts[index];
    // `call_tool` reaches a deferred tool; once Spade names that tool, the call reads as it.
    const named = name && part?.kind === "call" && part.name === "call_tool" ? name : part?.name;
    if (part?.kind !== "call" || !named || (part.state === callState && named === part.name))
      return;
    // Spade answers a declined call with an errored result; it stays what the person chose.
    if (part.state === "declined" && callState === "failed" && named === part.name) return;
    const parts = entry.parts.slice();
    parts[index] = {
      ...part,
      name: named,
      state: part.state === "declined" && callState === "failed" ? "declined" : callState,
    };
    state.entries[at.index] = { ...entry, parts };
    return;
  }
  if (!name) return;
  // A call no step listed (an older Spade): it shows where the reply is now.
  state.calls.set(callId, { reply, index: state.open.index });
  updateOpen(state, reply, (open) => ({
    ...open,
    parts: [...open.parts, { kind: "call", key: callId, name, state: callState }],
  }));
}

const unsettled = new Set<SpadeCallState>(["queued", "waiting", "running"]);

function setCallAt(state: SpadeConversationState, index: number, callId: string) {
  const entry = state.entries[index];
  if (entry?.kind !== "reply") return;
  const at = entry.parts.findIndex((part) => part.kind === "call" && part.key === callId);
  const part = entry.parts[at];
  if (part?.kind !== "call" || !unsettled.has(part.state)) return;
  const parts = entry.parts.slice();
  parts[at] = { ...part, state: "skipped" };
  state.entries[index] = { ...entry, parts };
}

function closeReply(
  state: SpadeConversationState,
  reply: string,
  end: SpadeReplyEnd,
  text: string,
): boolean {
  if (state.open?.reply !== reply) return false;
  closeOpen(state, end, text);
  return true;
}

/**
 * End the open reply. A finished reply's text repeats its last step's, already shown; any other
 * end carries the open step's words, which no step stored.
 */
function closeOpen(state: SpadeConversationState, end: SpadeReplyEnd, text: string) {
  const open = state.open;
  if (!open) return;
  const entry = state.entries[open.index];
  if (entry?.kind === "reply") {
    const last = entry.parts.findLast((part) => part.kind === "text");
    const words = end.kind === "finished" ? (last?.text === text ? "" : text) : text || entry.live;
    const parts: SpadeReplyPart[] = words.trim()
      ? [...entry.parts, { kind: "text", key: `${entry.key}:end`, text: words }]
      : entry.parts.slice();
    state.entries[open.index] = { ...entry, parts, live: "", end };
  }
  // A call left without a result when the reply ended never ran.
  for (const [callId, call] of state.calls) {
    if (call.reply !== open.reply) continue;
    setCallAt(state, call.index, callId);
    state.calls.delete(callId);
  }
  state.approvals = state.approvals.filter((approval) => approval.reply !== open.reply);
  for (const [callId, call] of state.running)
    if (call.reply === open.reply) state.running.delete(callId);
  state.open = undefined;
}
