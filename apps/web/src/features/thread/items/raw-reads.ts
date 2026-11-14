import type { RawPayload } from "@ace/protocol";

/*
 * How the Raw view reads a step's raw payloads with `item.raw` (hello trim `raw-on-demand`).
 * Pure: the hook around it sends the read it names and runs the refresh timer it asks for.
 *
 * - One read at a time, whoever wants it: opening, "Show more", a retry or a refresh. While one
 *   is out, "Show more" is not offered and other reads wait.
 * - A change to the step during a read makes it stale; exactly one read from the start follows
 *   when it ends: at once if the step has finished, else after the refresh interval.
 * - A read from the start replaces the list when its reply comes: the pages shown stay until
 *   then, and afterwards "Show more" reads on from the new first page.
 * - Closing keeps the read in flight (it is already on its way): its reply is kept, nothing
 *   follows while closed, and opening again waits for it rather than sending another. A reply
 *   to any read other than the one in flight (the hook's after unmount) changes nothing.
 */

export type RawPhase = "closed" | "idle" | "reading" | "stale" | "waiting";

/** A read the hook should send: `id` names it, so a reply to any other is dropped. */
export interface RawRead {
  id: number;
  from: number;
  revision: string | undefined;
}

export interface RawReads {
  phase: RawPhase;
  /** Every payload read so far, of one version, oldest first. */
  raw: readonly RawPayload[];
  revision: string | undefined;
  /** Where the next page starts; undefined once all are read. */
  next: number | undefined;
  /** Whether a first page has arrived. */
  started: boolean;
  /** The read that failed, for a retry to send again. */
  failed: RawRead | undefined;
  /** Whether the step may still change. */
  running: boolean;
  /** The step changed while the view was closed. */
  changedWhileClosed: boolean;
  /** The read in flight, in `reading` and `stale`. */
  read: RawRead | undefined;
  /** The last read id given out. */
  reads: number;
}

export interface RawReply {
  from: number;
  raw: readonly RawPayload[];
  revision: string;
  next?: number | undefined;
  changed?: true | undefined;
}

export type RawInput =
  | { type: "open" }
  | { type: "close" }
  | { type: "reply"; id: number; reply: RawReply }
  | { type: "error"; id: number }
  | { type: "changed"; running: boolean }
  | { type: "more" }
  | { type: "retry" }
  | { type: "timer" };

export function initialRawReads(running: boolean): RawReads {
  return {
    phase: "closed",
    raw: [],
    revision: undefined,
    next: 0,
    started: false,
    failed: undefined,
    running,
    changedWhileClosed: false,
    read: undefined,
    reads: 0,
  };
}

function reading(state: RawReads, from: number, revision: string | undefined): RawReads {
  const id = state.reads + 1;
  return { ...state, phase: "reading", read: { id, from, revision }, reads: id };
}

/** After a read ends: one read from the start if the step moved on, at once once it finished. */
function settled(state: RawReads, stale: boolean): RawReads {
  const done = { ...state, read: undefined };
  if (!stale) return { ...done, phase: "idle" };
  return state.running ? { ...done, phase: "waiting" } : reading(done, 0, undefined);
}

export function stepRawReads(state: RawReads, input: RawInput): RawReads {
  switch (input.type) {
    case "open":
      if (state.phase !== "closed") return state;
      // A read still out from before is waited for, never sent twice.
      if (state.read)
        return {
          ...state,
          phase: state.changedWhileClosed ? "stale" : "reading",
          changedWhileClosed: false,
        };
      return !state.started || state.changedWhileClosed
        ? reading({ ...state, changedWhileClosed: false }, 0, undefined)
        : { ...state, phase: "idle" };
    case "close":
      // The read out stays out: its reply is kept, but nothing follows while closed.
      return {
        ...state,
        phase: "closed",
        changedWhileClosed: state.phase === "stale" || state.changedWhileClosed,
      };
    case "reply": {
      if (state.read?.id !== input.id) return state;
      const { reply } = input;
      const closed = state.phase === "closed";
      // The version changed since the page before: read it again from the start.
      if (reply.changed)
        return closed
          ? { ...state, read: undefined, changedWhileClosed: true }
          : reading(state, 0, undefined);
      const fresh = reply.from === 0;
      const next: RawReads = {
        ...state,
        raw: fresh ? reply.raw : [...state.raw, ...reply.raw],
        revision: reply.revision,
        next: reply.next,
        started: true,
        failed: undefined,
      };
      if (closed) return { ...next, read: undefined };
      return settled(next, state.phase === "stale");
    }
    case "error":
      if (state.read?.id !== input.id) return state;
      if (state.phase === "closed") return { ...state, failed: state.read, read: undefined };
      return settled({ ...state, failed: state.read }, state.phase === "stale");
    case "changed": {
      const next = { ...state, running: input.running };
      switch (state.phase) {
        case "closed":
          return { ...next, changedWhileClosed: true };
        case "reading":
        case "stale":
          return { ...next, phase: "stale" };
        case "waiting":
          return input.running ? next : reading(next, 0, undefined);
        case "idle":
          if (!state.started) return next;
          return input.running ? { ...next, phase: "waiting" } : reading(next, 0, undefined);
      }
      return next;
    }
    case "more":
      return state.phase === "idle" && state.started && state.next !== undefined
        ? reading(state, state.next, state.revision)
        : state;
    case "retry":
      if (state.phase !== "idle" || !state.failed) return state;
      return reading(state, state.failed.from, state.failed.revision);
    case "timer":
      return state.phase === "waiting" ? reading(state, 0, undefined) : state;
  }
}

/** Whether "Show more" can start a read now: nothing else is out and pages are left. */
export function canReadMore(state: RawReads): boolean {
  return state.phase === "idle" && state.started && state.next !== undefined;
}
