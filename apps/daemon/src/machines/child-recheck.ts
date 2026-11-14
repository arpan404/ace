import type { MachineThreadView } from "@ace/protocol";
import { settledStates } from "../agent-control/watch-view.ts";

/*
 * Settled children on other machines can start again there: the person on that machine sends
 * the thread new work. Pairing is one-way (ADR 0078: the target holds no route back), so the
 * caller re-checks recently settled children with the ordinary status call, within these bounds
 * (ADR 0099).
 */

/**
 * Re-check a machine's settled children every this many polls (10 s at the default 1 s poll)
 * while one settled there recently, when work there is most likely to start again.
 */
export const RECHECK_POLLS = 10;
/**
 * The re-check slows as the youngest settled child on a machine ages: until it is `upTo` polls
 * old, every `every` polls. At the default 1 s poll: every 10 s for 2 minutes, 30 s until 10
 * minutes, 1 minute until an hour, 2.5 minutes until 4 hours, then every 5 minutes.
 */
const RECHECK_STEPS: readonly { upTo: number; every: number }[] = [
  { upTo: 120, every: RECHECK_POLLS },
  { upTo: 600, every: 30 },
  { upTo: 3600, every: 60 },
  { upTo: 14_400, every: 150 },
];
/** The slowest re-check, in polls: 5 minutes at the default 1 s poll. */
export const RECHECK_SLOWEST_POLLS = 300;

/**
 * How many polls apart a machine's settled children are re-checked, from how many polls ago its
 * youngest settled child settled (`undefined`: none has a settle time, the slowest pace).
 */
export function recheckEveryPolls(agePolls: number | undefined): number {
  if (agePolls === undefined) return RECHECK_SLOWEST_POLLS;
  return RECHECK_STEPS.find((step) => agePolls < step.upTo)?.every ?? RECHECK_SLOWEST_POLLS;
}

/** What the schedule needs to know about one machine (`ChildLedger.recheckMachines`). */
export interface RecheckFacts {
  /** When its youngest settled child settled. */
  latest: number | null;
  /** A child there is past its 24 h mark and still owed its last check. */
  expired: boolean;
  /** A stop there is still unconfirmed: its real end is read at the fast pace. */
  unconfirmed: boolean;
}

/**
 * When each machine's settled children are next re-checked. Pure: the caller passes the time,
 * the poll interval, the machine's facts, and which re-checks were answered.
 *
 * The rule it keeps: no child sits on a slow pace, or leaves tracking, without a check answered
 * after the last thing that could have reopened it unseen.
 * - Children are read in rounds: a round covers every child tracked on the machine, sixteen per
 *   call, one call every fast interval (10 s) until the round is done. The age-based pace only
 *   sets the wait between rounds.
 * - A daemon that just started knows nothing of what happened while it was down: its first round
 *   on each machine starts at the fast pace.
 * - A re-check that failed is not a check: the machine stays due, asked again as soon as its
 *   failure backoff allows.
 * - A child past its 24 h mark, or a stop still unconfirmed, keeps the machine on the fast pace.
 *   A child leaves tracking only once a check made at or after its 24 h mark is answered (the
 *   caller closes its window then); no timer ends tracking on its own.
 */
export class RecheckSchedule {
  private pollMs: number;
  private start: number;
  private last = new Map<string, number>();
  private polls = new Map<string, number>();
  /** Per machine, the children the current round has not asked yet; absent before the first. */
  private rounds = new Map<string, Set<string>>();
  /** Per machine, the children asked whose read has not been answered yet. */
  private owed = new Map<string, Set<string>>();
  constructor(pollMs: number, start: number) {
    this.pollMs = pollMs;
    this.start = start;
  }
  /**
   * A turn on `machine` is about to be taken; `tracked` is every child tracked there now. A new
   * round begins when the last one has asked every child; children no longer tracked leave it.
   * Returns the children the round has not asked yet, and those asked but still unanswered.
   */
  turn(machine: string, tracked: readonly string[]): { pending: string[]; owed: string[] } {
    const now = new Set(tracked);
    const round = this.rounds.get(machine);
    const pending =
      round && round.size > 0 ? new Set([...round].filter((id) => now.has(id))) : new Set(now);
    const owed = new Set([...(this.owed.get(machine) ?? [])].filter((id) => now.has(id)));
    this.rounds.set(machine, pending);
    this.owed.set(machine, owed);
    return { pending: [...pending], owed: [...owed] };
  }
  /**
   * The turn at `now` asks `ids`: they leave the round, and each is owed an answer until one
   * comes. The machine's next turn is timed from this one.
   */
  picked(machine: string, ids: readonly string[], now: number): void {
    this.last.set(machine, now);
    this.polls.set(machine, 0);
    const round = this.rounds.get(machine);
    const owed = this.owed.get(machine) ?? new Set<string>();
    for (const id of ids) {
      round?.delete(id);
      owed.add(id);
    }
    this.owed.set(machine, owed);
  }
  /**
   * `ids` on `machine` answered a re-check at `now`. Returns those it read at or after their
   * 24 h mark, whose re-check window the caller closes.
   */
  answered(
    machine: string,
    ids: readonly { id: string; settledAt: number | null }[],
    now: number,
  ): { id: string; settledAt: number }[] {
    const round = this.rounds.get(machine);
    const owed = this.owed.get(machine);
    const ended: { id: string; settledAt: number }[] = [];
    for (const { id, settledAt } of ids) {
      round?.delete(id);
      owed?.delete(id);
      if (settledAt !== null && now - settledAt >= RECHECK_WINDOW_MS) ended.push({ id, settledAt });
    }
    return ended;
  }
  /** When `machine` is due. */
  dueAt(machine: string, facts: RecheckFacts, now: number): number {
    const last = this.last.get(machine) ?? this.start;
    return last + this.everyPolls(machine, facts, now) * this.pollMs;
  }
  /**
   * Whether a poll at `now` re-checks `machine`: its time has come by the clock, or as many polls
   * have run since its last answered re-check, which holds even if the clock stalls.
   */
  due(machine: string, facts: RecheckFacts, now: number): boolean {
    const polls = (this.polls.get(machine) ?? 0) + 1;
    this.polls.set(machine, polls);
    return now >= this.dueAt(machine, facts, now) || polls >= this.everyPolls(machine, facts, now);
  }
  /** Machines with no settled child to re-check keep no schedule. */
  retain(machines: ReadonlySet<string>): void {
    for (const map of [this.last, this.polls, this.rounds, this.owed])
      for (const machine of map.keys()) if (!machines.has(machine)) map.delete(machine);
  }
  private everyPolls(machine: string, facts: RecheckFacts, now: number): number {
    const round = this.rounds.get(machine);
    // The first round after start, the rest of a round, a child asked but not yet answered, a
    // child owed its last check, or a stop still unconfirmed: the fast pace.
    if (
      !round ||
      round.size > 0 ||
      (this.owed.get(machine)?.size ?? 0) > 0 ||
      facts.expired ||
      facts.unconfirmed
    )
      return RECHECK_POLLS;
    const age = facts.latest === null ? undefined : Math.max(0, now - facts.latest) / this.pollMs;
    return recheckEveryPolls(age);
  }
}
/**
 * The children one re-check turn asks about, at most `limit`, in round-robin order so none
 * starves: those the round has not asked yet first, then those asked whose read failed. Among
 * each, children past their 24 h mark go first, then those checked longest ago. A child whose
 * reads keep failing waits out its own backoff (`due`); when it is due it takes its place by
 * these rules, never ahead of a child the round has not asked yet. A child the round has asked
 * and that answered is not asked again until the next round.
 */
export function recheckPicks<
  T extends { id: string; settled_at: number | null; rechecked: number },
>(
  rows: readonly T[],
  expiry: number,
  turn: { pending: readonly string[]; owed: readonly string[] },
  due: (id: string) => boolean,
  limit: number,
): T[] {
  const pending = new Set(turn.pending);
  const owed = new Set(turn.owed);
  const rank = (row: T) => [
    pending.has(row.id) ? 0 : 1,
    row.settled_at !== null && row.settled_at < expiry ? 0 : 1,
    row.rechecked,
  ];
  return rows
    .filter((row) => (pending.has(row.id) || owed.has(row.id)) && due(row.id))
    .toSorted((a, b) => {
      const [x, y] = [rank(a), rank(b)];
      for (let index = 0; index < x.length; index++)
        if (x[index] !== y[index]) return (x[index] ?? 0) - (y[index] ?? 0);
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, limit);
}

/**
 * Children settled this recently are re-checked at the age-based pace; one past it is read once
 * more, then leaves tracking.
 */
export const RECHECK_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * At most this many children per machine per re-check, one status call each; each machine's
 * children checked longest ago go first, so every one is checked in turn.
 */
export const RECHECK_PER_MACHINE = 16;

/**
 * What a re-read view of a settled child means: it runs again (`reopen`), it ran again and
 * settled with a different result or failure reason (`settle`, a new result for the parent: a
 * stop found later to be a usage limit says so), or nothing that matters to the parent changed
 * (`ignore`, so a title or pin there never repeats a result).
 */
export function recheckOutcome(
  saved: MachineThreadView | undefined,
  view: MachineThreadView,
): "reopen" | "settle" | "ignore" {
  if (!settledStates.has(view.state) || view.requests.length > 0) return "reopen";
  if (
    saved &&
    saved.state === view.state &&
    (saved.result ?? "") === (view.result ?? "") &&
    saved.failure?.code === view.failure?.code
  )
    return "ignore";
  return "settle";
}
