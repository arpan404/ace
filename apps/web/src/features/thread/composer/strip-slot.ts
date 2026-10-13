/**
 * The composer's one strip slot. Several things want the room above the composer; it shows one,
 * the rest as small indicators inside it. By default the most urgent shows: a Stop waiting for
 * its second Esc (it answers the key just pressed, and lasts only a moment), a request needing
 * the person, then trouble with the connection, then background commands a stopped turn left
 * running, then the queue, then plan progress. The person can switch the slot to any present
 * item; a request that arrives after that, or one a notification opens, takes it back. Pure.
 */
export const stripPriority = [
  "confirm-stop",
  "request",
  "connection",
  "stopped",
  "queue",
  "plan",
] as const;
export type StripKind = (typeof stripPriority)[number];

/** What could fill the slot right now. */
export interface StripFacts {
  /** One Esc pressed while the agent works: another one soon stops it. */
  confirmStop: boolean;
  /** The open requests' ids, oldest first. */
  requests: readonly string[];
  /** The request a notification opened the thread on, if any. */
  target?: string | undefined;
  connection: boolean;
  /** The turn was stopped and background commands it started still run. */
  stopped: boolean;
  queue: boolean;
  plan: boolean;
}

/** The person moved the slot to `kind`, while these requests were already open. */
export interface StripPick {
  kind: StripKind;
  seen: readonly string[];
  /** The notification target at the time. */
  target: string | undefined;
}

export interface StripSlot {
  shown: StripKind | undefined;
  /** The other present items, in priority order: the indicators. */
  others: readonly StripKind[];
}

const present = (facts: StripFacts, kind: StripKind) =>
  kind === "request"
    ? facts.requests.length > 0
    : kind === "confirm-stop"
      ? facts.confirmStop
      : facts[kind];

export function stripSlot(facts: StripFacts, pick: StripPick | undefined): StripSlot {
  const items = stripPriority.filter((kind) => present(facts, kind));
  const targeted =
    facts.target !== undefined && facts.requests.includes(facts.target) ? facts.target : undefined;
  const arrived = pick
    ? facts.requests.some((id) => !pick.seen.includes(id)) ||
      (targeted !== undefined && targeted !== pick.target)
    : false;
  // The pending Stop answers the key just pressed: no earlier choice hides it.
  const shown = facts.confirmStop
    ? "confirm-stop"
    : pick && !arrived && items.includes(pick.kind)
      ? pick.kind
      : (items[0] as StripKind | undefined);
  // It is never an indicator either: it is there only while it shows.
  return { shown, others: items.filter((kind) => kind !== shown && kind !== "confirm-stop") };
}

/** The person chose `kind` from an indicator; choosing a request goes back to the default. */
export function pickStrip(kind: StripKind, facts: StripFacts): StripPick | undefined {
  return kind === "request" ? undefined : { kind, seen: facts.requests, target: facts.target };
}
