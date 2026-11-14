import { RECHECK_POLLS, RECHECK_WINDOW_MS, recheckEveryPolls } from "./child-recheck.ts";

/*
 * Which of one machine's children are read in each turn, in which calls, and what each call's
 * outcome means for them (ADR 0099). Pure: the caller passes the children, what it remembers of
 * each, and the time; it makes the calls and folds each outcome back in as it arrives.
 *
 * Every child has its own next due time:
 * - a working child, every poll;
 * - a settled child, after an interval that grows with its age (10 s at first, up to 5 minutes),
 *   from its last answered check; one past its 24 h mark, or whose stop is unconfirmed, every
 *   10 s; one this daemon has not checked since it started, 10 s after start;
 * - a child whose last read failed, when its own backoff ends (doubling from one poll to 30 s).
 * Due children are taken earliest due first, so none starves. A suspect child (its last call
 * failed or was refused for another's sake) is asked alone until it answers alone; the rest share
 * calls. An unpaired child is never asked and never counts as checked.
 */

/** One child as the ledger and the pairings have it now. */
export interface ScheduleChild {
  id: string;
  /** Settled children are re-checked; working ones are read every poll. */
  settled: boolean;
  settledAt: number | null;
  /** Its stop was never confirmed: its real end is read at the fast pace. */
  unconfirmed: boolean;
  /** Its machine is still paired as the device it was delegated through. */
  paired: boolean;
}

/** What the scheduler remembers of one child; nothing of this survives a restart. */
export interface ChildRecord {
  /** When a read of it was last answered (a view, or the machine saying it doesn't hold it). */
  lastAnsweredAt?: number;
  /** When it was last asked. */
  lastAskedAt?: number;
  /** Reads of it that failed in a row. */
  failures: number;
  /** Not asked again before this, after a failure. */
  retryAt?: number;
  /** Its last call failed, or was refused for another's sake: asked alone until it answers. */
  suspect: boolean;
  /** A call asking about it is on its way. */
  inFlight: boolean;
}

export interface ScheduleConfig {
  pollMs: number;
  /** When this daemon started, by the injected clock. */
  start: number;
  /** The longest wait after failures. */
  retryCapMs: number;
  /** Children per call, the call's own limit. */
  idsPerCall: number;
  /** Calls per turn per machine. */
  callsPerTurn: number;
}

export const defaultScheduleConfig = (pollMs: number, start: number): ScheduleConfig => ({
  pollMs,
  start,
  retryCapMs: 30_000,
  idsPerCall: 16,
  callsPerTurn: 16,
});

export type Records = ReadonlyMap<string, ChildRecord>;

const blank = (): ChildRecord => ({ failures: 0, suspect: false, inFlight: false });

/** When `child` is next due, or undefined when it is never asked (unpaired) or asked now. */
export function dueAt(
  child: ScheduleChild,
  record: ChildRecord | undefined,
  now: number,
  config: ScheduleConfig,
): number | undefined {
  if (!child.paired || record?.inFlight) return undefined;
  const rec = record ?? blank();
  // A failed read is not a read: asked again when its own wait is over.
  if (rec.failures > 0 && rec.retryAt !== undefined) return rec.retryAt;
  // A child refused for another's sake is asked again, alone, at once.
  if (rec.suspect && rec.lastAskedAt !== undefined && rec.failures === 0) return rec.lastAskedAt;
  if (!child.settled)
    return rec.lastAskedAt === undefined ? config.start : rec.lastAskedAt + config.pollMs;
  const fast = RECHECK_POLLS * config.pollMs;
  if (rec.lastAnsweredAt === undefined) return config.start + fast;
  const expired = child.settledAt !== null && now - child.settledAt >= RECHECK_WINDOW_MS;
  if (expired || child.unconfirmed || child.settledAt === null) return rec.lastAnsweredAt + fast;
  const agePolls = Math.max(0, now - child.settledAt) / config.pollMs;
  return rec.lastAnsweredAt + recheckEveryPolls(agePolls) * config.pollMs;
}

export interface TurnPlan {
  /** The calls to make now, each the ids it asks about. */
  calls: string[][];
  /** The records with the asked children marked in flight. */
  records: Map<string, ChildRecord>;
  /** Settled children past their 24 h mark whose machine is unpaired: the person is asked. */
  unpairedExpired: string[];
}

/**
 * This turn's calls for one machine: due children earliest due first (ties by id); a suspect
 * child alone in its call, the rest sixteen to a call; at most `callsPerTurn` calls.
 */
export function planTurn(
  children: readonly ScheduleChild[],
  records: Records,
  now: number,
  config: ScheduleConfig,
): TurnPlan {
  const next = new Map(records);
  const due = children
    .map((child) => ({ child, at: dueAt(child, records.get(child.id), now, config) }))
    .filter((entry): entry is { child: ScheduleChild; at: number } => entry.at !== undefined)
    .filter((entry) => entry.at <= now)
    .toSorted((a, b) => a.at - b.at || (a.child.id < b.child.id ? -1 : 1));
  const calls: string[][] = [];
  let open: string[] | undefined;
  for (const { child } of due) {
    if (records.get(child.id)?.suspect) {
      if (calls.length >= config.callsPerTurn) break;
      calls.push([child.id]);
      continue;
    }
    if (!open || open.length >= config.idsPerCall) {
      if (calls.length >= config.callsPerTurn) break;
      open = [];
      calls.push(open);
    }
    open.push(child.id);
  }
  for (const id of calls.flat())
    next.set(id, { ...(records.get(id) ?? blank()), inFlight: true, lastAskedAt: now });
  const unpairedExpired = children
    .filter(
      (child) =>
        !child.paired &&
        child.settled &&
        child.settledAt !== null &&
        now - child.settledAt >= RECHECK_WINDOW_MS,
    )
    .map((child) => child.id);
  // Records of children no longer tracked are dropped.
  const tracked = new Set(children.map((child) => child.id));
  for (const id of next.keys()) if (!tracked.has(id)) next.delete(id);
  return { calls, records: next, unpairedExpired };
}

/** The earliest time any of the machine's children is due, or undefined when none will be. */
export function nextDue(
  children: readonly ScheduleChild[],
  records: Records,
  now: number,
  config: ScheduleConfig,
): number | undefined {
  let next: number | undefined;
  for (const child of children) {
    const at = dueAt(child, records.get(child.id), now, config);
    if (at !== undefined && (next === undefined || at < next)) next = at;
  }
  return next;
}

/** What came back for one call. */
export type CallOutcome =
  | { kind: "answered" }
  /** The machine refused the call: it holds no record of a child in it from this machine. */
  | { kind: "not_found" }
  /** No answer: unreachable, lost, timed out, or refused for any other reason. */
  | { kind: "failed" };

export interface FoldResult {
  records: Map<string, ChildRecord>;
  /** Settled children whose read was answered at or after their 24 h mark: they leave tracking. */
  ended: string[];
}

const backoff = (failures: number, config: ScheduleConfig) =>
  Math.min(config.retryCapMs, config.pollMs * 2 ** Math.min(failures - 1, 30));

/** Folds one call's outcome, at `now`, into the records of the children it asked about. */
export function foldCall(
  records: Records,
  children: readonly ScheduleChild[],
  ids: readonly string[],
  outcome: CallOutcome,
  now: number,
  config: ScheduleConfig,
): FoldResult {
  const next = new Map(records);
  const byId = new Map(children.map((child) => [child.id, child]));
  const ended: string[] = [];
  const answered = (id: string) => {
    const child = byId.get(id);
    if (
      child?.settled &&
      child.settledAt !== null &&
      now - child.settledAt >= RECHECK_WINDOW_MS
    )
      ended.push(id);
  };
  for (const id of ids) {
    const rec = { ...(records.get(id) ?? blank()), inFlight: false };
    if (outcome.kind === "answered") {
      next.set(id, {
        ...rec,
        failures: 0,
        suspect: false,
        lastAnsweredAt: now,
        ...{ retryAt: undefined },
      });
      answered(id);
    } else if (outcome.kind === "not_found" && ids.length > 1) {
      // Refused for one child's sake: each is asked alone next, at once.
      next.set(id, { ...rec, suspect: true });
    } else {
      // Failed, or the machine doesn't hold this child: asked alone, later after each time.
      const failures = rec.failures + 1;
      next.set(id, {
        ...rec,
        failures,
        retryAt: now + backoff(failures, config),
        suspect: true,
        ...(outcome.kind === "not_found" ? { lastAnsweredAt: now } : {}),
      });
      // The machine saying it doesn't hold the child is its answer for it.
      if (outcome.kind === "not_found") answered(id);
    }
  }
  return { records: next, ended };
}

/** Another call to the machine got through: children waiting out a failure are due now. */
export function retryNow(records: Records, now: number): Map<string, ChildRecord> {
  const next = new Map(records);
  for (const [id, rec] of records)
    if (rec.failures > 0 && rec.retryAt !== undefined && rec.retryAt > now)
      next.set(id, { ...rec, retryAt: now });
  return next;
}
