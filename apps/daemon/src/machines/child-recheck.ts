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
 * When each machine's settled children are next re-checked. Pure: the caller passes the time,
 * the poll interval and when each machine's youngest settled child settled.
 */
export class RecheckSchedule {
  private pollMs: number;
  private start: number;
  private last = new Map<string, number>();
  private polls = new Map<string, number>();
  constructor(pollMs: number, start: number) {
    this.pollMs = pollMs;
    this.start = start;
  }
  /** When `machine` is due, its youngest child having settled at `latest`. */
  dueAt(machine: string, latest: number | null, now: number): number {
    const last = this.last.get(machine) ?? this.start;
    const age = latest === null ? undefined : Math.max(0, now - latest) / this.pollMs;
    return last + recheckEveryPolls(age) * this.pollMs;
  }
  /**
   * Whether a poll at `now` re-checks `machine`: its time has come by the clock, or as many polls
   * have run since its last re-check, which holds even if the clock stalls.
   */
  due(machine: string, latest: number | null, now: number): boolean {
    const polls = (this.polls.get(machine) ?? 0) + 1;
    this.polls.set(machine, polls);
    const age = latest === null ? undefined : Math.max(0, now - latest) / this.pollMs;
    return now >= this.dueAt(machine, latest, now) || polls >= recheckEveryPolls(age);
  }
  checked(machine: string, now: number): void {
    this.last.set(machine, now);
    this.polls.set(machine, 0);
  }
  /** Machines with no settled child to re-check keep no schedule. */
  retain(machines: ReadonlySet<string>): void {
    for (const machine of this.last.keys()) if (!machines.has(machine)) this.last.delete(machine);
    for (const machine of this.polls.keys()) if (!machines.has(machine)) this.polls.delete(machine);
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
