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

/**
 * When each machine's settled children are next re-checked, and which of them still owe a check
 * that only this daemon's memory can tell. Pure: the caller passes the time, the poll interval,
 * when each machine's youngest settled child settled, and which re-checks were answered.
 *
 * The rule it keeps: no child sits on a slow pace, or leaves tracking, without a check answered
 * after the last thing that could have reopened it unseen.
 * - A daemon that just started knows nothing of what happened while it was down: every machine is
 *   re-checked at the fast pace until each settled child saved there has been read once.
 * - A re-check that failed is not a check: the machine stays due, asked again as soon as its
 *   failure backoff allows.
 * - A child reaching the end of the 24-hour window is kept for up to `graceMs` more, first in
 *   line, until one check answered at that age; then it leaves tracking.
 */
export class RecheckSchedule {
  private pollMs: number;
  private start: number;
  private last = new Map<string, number>();
  private polls = new Map<string, number>();
  /** Per machine, the settled children saved at start not yet read since. */
  private unread = new Map<string, Set<string>>();
  /** Children read at or past the end of the window, by when they settled. */
  private final = new Map<string, number>();
  constructor(pollMs: number, start: number) {
    this.pollMs = pollMs;
    this.start = start;
  }
  /** How long past the window a child waits for its last check: two of the slowest intervals. */
  get graceMs(): number {
    return 2 * RECHECK_SLOWEST_POLLS * this.pollMs;
  }
  /** Whether the start pass for `machine` has begun; it begins once, with what was saved. */
  started(machine: string): boolean {
    return this.unread.has(machine);
  }
  /** The settled children saved for `machine` when this daemon first looked at it. */
  begin(machine: string, ids: readonly string[]): void {
    if (!this.unread.has(machine)) this.unread.set(machine, new Set(ids));
  }
  /** `ids` on `machine` answered a re-check at `now`; those past the window are done for good. */
  answered(machine: string, ids: readonly { id: string; settledAt: number | null }[], now: number) {
    this.last.set(machine, now);
    this.polls.set(machine, 0);
    const unread = this.unread.get(machine);
    for (const { id, settledAt } of ids) {
      unread?.delete(id);
      if (settledAt !== null && now - settledAt >= RECHECK_WINDOW_MS) this.final.set(id, settledAt);
    }
  }
  /** Children whose last check is done, so they leave tracking; older entries are forgotten. */
  finished(now: number): string[] {
    for (const [id, settledAt] of this.final)
      if (settledAt < now - RECHECK_WINDOW_MS - this.graceMs) this.final.delete(id);
    return [...this.final.keys()];
  }
  /** When `machine` is due, its youngest child having settled at `latest`. */
  dueAt(machine: string, latest: number | null, now: number): number {
    const last = this.last.get(machine) ?? this.start;
    return last + this.everyPolls(machine, latest, now) * this.pollMs;
  }
  /**
   * Whether a poll at `now` re-checks `machine`: its time has come by the clock, or as many polls
   * have run since its last answered re-check, which holds even if the clock stalls.
   */
  due(machine: string, latest: number | null, now: number): boolean {
    const polls = (this.polls.get(machine) ?? 0) + 1;
    this.polls.set(machine, polls);
    return (
      now >= this.dueAt(machine, latest, now) || polls >= this.everyPolls(machine, latest, now)
    );
  }
  /** Machines with no settled child to re-check keep no schedule. */
  retain(machines: ReadonlySet<string>): void {
    for (const map of [this.last, this.polls, this.unread])
      for (const machine of map.keys()) if (!machines.has(machine)) map.delete(machine);
  }
  private everyPolls(machine: string, latest: number | null, now: number): number {
    // Until every child saved at start has been read, whatever their age: the fast pace.
    const unread = this.unread.get(machine);
    if (!unread || unread.size > 0) return RECHECK_POLLS;
    const age = latest === null ? undefined : Math.max(0, now - latest) / this.pollMs;
    return recheckEveryPolls(age);
  }
}
/** Only children settled this recently are re-checked. */
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
