import {
  RECHECK_POLLS,
  RECHECK_SLOWEST_POLLS,
  RECHECK_WINDOW_MS,
  recheckEveryPolls,
} from "./child-recheck.ts";

/*
 * Which of one machine's children are read in each turn, in which calls, and what each call's
 * outcome means for them (ADR 0099). Pure: the caller passes the children, what it remembers of
 * each, and the time; it makes the calls and folds each outcome back in as it arrives.
 *
 * Every child has its own next due time:
 * - a working child, on every turn (one a poll);
 * - a settled child, after an interval that grows with its age (10 s at first, up to 5 minutes),
 *   from its last answered check; one past its 24 h mark, or whose stop is unconfirmed, every
 *   10 s; one this daemon has not checked since it started, 10 s after start;
 * - a child whose own read failed (asked alone), when its backoff ends (doubling from one poll to
 *   30 s).
 * Due children are taken earliest due first, so none starves. A child in a call that failed or
 * was refused, with others, is implicated: it is asked again at once, alone, and stays alone until
 * it has answered alone and for a time that starts at 10 s and doubles each time it is
 * implicated (up to an hour),
 * so a child that only fails beside others can't keep taking calls down. Only a child's own
 * failures, asked alone, back it off. An unpaired child is never asked and never counts as
 * checked.
 */

/** One child as the ledger and the pairings have it now. */
export interface ScheduleChild {
  id: string;
  /** Settled children are re-checked; working ones are read every poll. */
  settled: boolean;
  settledAt: number | null;
  /** Its stop was never confirmed: its real end is read at the fast pace. */
  unconfirmed: boolean;
  /** Being stopped: asked ahead of every other due child, so its stop is confirmed in time. */
  stopping?: boolean;
  /** Its machine is still paired as the device it was delegated through. */
  paired: boolean;
}

/** What the scheduler remembers of one child; nothing of this survives a restart. */
export interface ChildRecord {
  /** When a read of it was last answered (a view, or the machine saying it doesn't hold it). */
  lastAnsweredAt?: number;
  /** When it was last asked. */
  lastAskedAt?: number;
  /** Reads of it alone that failed in a row. */
  failures: number;
  /** Not asked again before this, after a failure. */
  retryAt?: number;
  /**
   * Its last failure came while nothing else on its machine answered either: the machine's, not
   * its own, so the machine answering again ends the wait.
   */
  machineWide?: boolean;
  /** It was in a call that failed or was refused with others: alone until it answers alone. */
  suspect: boolean;
  /** When it was last implicated; it is asked again, alone, at once after that. */
  implicatedAt?: number;
  /** Times it was implicated; each doubles how long it stays alone. */
  implicated: number;
  /** Alone until this, even after answering alone. */
  aloneUntil?: number;
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
  /** The longest a child implicated again and again stays alone. */
  aloneCapMs: number;
  /** Calls per turn per machine. */
  callsPerTurn: number;
}

export const defaultScheduleConfig = (pollMs: number, start: number): ScheduleConfig => ({
  pollMs,
  start,
  retryCapMs: 30_000,
  idsPerCall: 16,
  aloneCapMs: 60 * 60_000,
  callsPerTurn: 16,
});

export type Records = ReadonlyMap<string, ChildRecord>;

const blank = (): ChildRecord => ({ failures: 0, suspect: false, implicated: 0, inFlight: false });

/**
 * The record of a child saved as asked alone, after a restart: alone until it answers alone,
 * asked again at once (ADR 0099: isolation outlives a restart).
 */
export function restored(): ChildRecord {
  return { ...blank(), suspect: true };
}

/** Whether `record`'s child goes in a call of its own at `now`. */
export function asksAlone(record: ChildRecord | undefined, now: number): boolean {
  if (!record) return false;
  return (
    record.suspect ||
    record.failures > 0 ||
    (record.aloneUntil !== undefined && now < record.aloneUntil)
  );
}

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
  // Implicated and not answered since: asked again, alone, at once.
  if (
    rec.suspect &&
    rec.implicatedAt !== undefined &&
    (rec.lastAnsweredAt === undefined || rec.lastAnsweredAt < rec.implicatedAt)
  )
    return rec.implicatedAt;
  // A working child is read one poll after it was last asked; one with a call on its way is
  // skipped above.
  if (!child.settled)
    return rec.lastAskedAt === undefined ? config.start : rec.lastAskedAt + config.pollMs;
  const fast = RECHECK_POLLS * config.pollMs;
  if (rec.lastAnsweredAt === undefined) return config.start + fast;
  if (child.unconfirmed || child.settledAt === null) return rec.lastAnsweredAt + fast;
  const agePolls = Math.max(0, now - child.settledAt) / config.pollMs;
  const slow = rec.lastAnsweredAt + recheckEveryPolls(agePolls) * config.pollMs;
  // Checked at its 24 h mark if that comes before its next slow check, and at the fast pace from
  // then on.
  return Math.min(slow, Math.max(child.settledAt + RECHECK_WINDOW_MS, rec.lastAnsweredAt + fast));
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
 * This turn's calls for one machine: due children being stopped first, then earliest due, then
 * those asked longest ago, then by id; a suspect child alone in its call, the rest sixteen to a call; at most
 * `callsPerTurn` calls. More due than fits waits for the next turn, first in line then: every due
 * child is asked within `ceil(n / callsPerTurn)` turns of coming due, n being the children there.
 */
export function planTurn(
  children: readonly ScheduleChild[],
  records: Records,
  now: number,
  config: ScheduleConfig,
  /**
   * When the turn was set for, if later than `now` (a timer can run a moment early): a child's
   * own next check counts as due then. A wait after a failure counts only against `now`.
   */
  setFor = now,
): TurnPlan {
  const next = new Map(records);
  const by = Math.max(now, setFor);
  const due = children
    .map((child) => {
      const record = records.get(child.id);
      const waiting = record !== undefined && record.failures > 0 && record.retryAt !== undefined;
      return {
        child,
        at: dueAt(child, record, by, config),
        limit: waiting ? now : by,
        asked: record?.lastAskedAt ?? Number.NEGATIVE_INFINITY,
        first: child.stopping === true ? 0 : 1,
      };
    })
    .filter(
      (
        entry,
      ): entry is {
        child: ScheduleChild;
        at: number;
        limit: number;
        asked: number;
        first: number;
      } => entry.at !== undefined && entry.at <= entry.limit,
    )
    .toSorted(
      (a, b) =>
        a.first - b.first || a.at - b.at || a.asked - b.asked || (a.child.id < b.child.id ? -1 : 1),
    );
  const calls: string[][] = [];
  let open: string[] | undefined;
  for (const { child } of due) {
    if (asksAlone(records.get(child.id), now)) {
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

/**
 * The earliest time anything owed on the machine is due, or undefined when nothing is: a child's
 * next read, or for a settled child whose machine is unpaired the next look at its pairing (one
 * slowest interval away at most) or its 24 h mark, when the person is asked. Undefined only while
 * every child it could ask has a call on its way.
 */
export function nextDue(
  children: readonly ScheduleChild[],
  records: Records,
  now: number,
  config: ScheduleConfig,
): number | undefined {
  let next: number | undefined;
  const take = (at: number) => {
    if (next === undefined || at < next) next = at;
  };
  for (const child of children) {
    const at = dueAt(child, records.get(child.id), now, config);
    if (at !== undefined) take(at);
    else if (!child.paired) {
      take(now + RECHECK_SLOWEST_POLLS * config.pollMs);
      if (child.settled && child.settledAt !== null) take(child.settledAt + RECHECK_WINDOW_MS);
    }
  }
  return next;
}

/** What came back for one call. */
export type CallOutcome =
  | { kind: "answered" }
  /** The machine refused the call: it holds no record of a child in it from this machine. */
  | { kind: "not_found" }
  /**
   * No answer: unreachable, lost, timed out, or refused for any other reason. `machineWide` when
   * nothing else on the machine answered around it either.
   */
  | { kind: "failed"; machineWide?: boolean }
  /** An answer came that could not be applied here (a busy store): as if it was never asked. */
  | { kind: "unapplied" };

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
    if (child?.settled && child.settledAt !== null && now - child.settledAt >= RECHECK_WINDOW_MS)
      ended.push(id);
  };
  for (const id of ids) {
    const rec: ChildRecord = { ...(records.get(id) ?? blank()), inFlight: false };
    // Nothing learned: due again as before this call, a working child on the next turn.
    if (outcome.kind === "unapplied") next.set(id, rec);
    else if (outcome.kind === "answered") {
      const { retryAt: _retryAt, ...rest } = rec;
      // Answered alone: it may share calls again once its time alone is over.
      next.set(id, {
        ...rest,
        failures: 0,
        lastAnsweredAt: now,
        suspect: ids.length > 1 && rec.suspect,
      });
      answered(id);
    } else if (ids.length > 1) {
      // Failed or refused beside others: nobody can tell whose doing it was. Each is asked
      // again alone, at once, and stays alone longer each time this happens to it.
      const implicated = rec.implicated + 1;
      next.set(id, {
        ...rec,
        suspect: true,
        implicated,
        implicatedAt: now,
        // Ten seconds alone the first time, doubling each time after, up to an hour.
        aloneUntil:
          now +
          Math.min(
            config.aloneCapMs,
            RECHECK_POLLS * config.pollMs * 2 ** Math.min(implicated - 1, 30),
          ),
      });
    } else {
      // Its own read failed, or the machine doesn't hold it: asked again later each time.
      const failures = rec.failures + 1;
      next.set(id, {
        ...rec,
        failures,
        retryAt: now + backoff(failures, config),
        machineWide: outcome.kind === "failed" && outcome.machineWide === true,
        ...(outcome.kind === "not_found" ? { lastAnsweredAt: now } : {}),
      });
      // The machine saying it doesn't hold the child is its answer for it.
      if (outcome.kind === "not_found") answered(id);
    }
  }
  return { records: next, ended };
}

/**
 * The machine answered again. Children whose last failure was the machine's (nothing else there
 * answered then) are due now; a child whose own read failed while its machine answered others
 * keeps its wait: the machine answering says nothing of it.
 */
export function machineBack(records: Records, now: number): Map<string, ChildRecord> {
  const next = new Map(records);
  for (const [id, rec] of records)
    if (rec.machineWide && rec.failures > 0 && rec.retryAt !== undefined && rec.retryAt > now)
      next.set(id, { ...rec, retryAt: now });
  return next;
}
