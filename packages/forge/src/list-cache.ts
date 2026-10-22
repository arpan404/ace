import type { ForgeIssueList } from "@ace/protocol/forge-issues";
import type { ForgeOpenWork, ForgePrList } from "@ace/protocol/forge-browser";
import type { ForgePerson, ForgeReference } from "@ace/protocol/forge-people";

/** How long a list read answers repeats without asking GitHub again. */
export const listFreshMs = 60_000;
const maxEntries = 64;

interface Flight<T> {
  promise: Promise<T>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}

/**
 * One kind of repository list (open PRs, open issues), keyed by its search. A read within
 * `freshMs` of the last answer reuses it; reads of the same search while one is on its way share
 * it, and the shared read stops only once every reader has gone. `invalidate` forgets every
 * answer, and a read already on its way when it runs is not kept.
 */
export class ListCache<T> {
  readonly #now: () => number;
  readonly #freshMs: number;
  readonly #entries = new Map<string, { value: T; at: number }>();
  readonly #flights = new Map<string, Flight<T>>();
  #generation = 0;
  constructor(now: () => number, freshMs = listFreshMs) {
    this.#now = now;
    this.#freshMs = freshMs;
  }
  async read(key: string, signal: AbortSignal, load: (signal: AbortSignal) => Promise<T>) {
    signal.throwIfAborted();
    const entry = this.#entries.get(key);
    if (entry && this.#now() - entry.at < this.#freshMs) return entry.value;
    const flight = this.#flights.get(key) ?? this.#start(key, load);
    flight.waiters++;
    try {
      return await untilAborted(flight.promise, signal);
    } finally {
      flight.waiters--;
      if (flight.waiters === 0 && !flight.settled) {
        flight.controller.abort();
        if (this.#flights.get(key) === flight) this.#flights.delete(key);
      }
    }
  }
  invalidate(): void {
    this.#generation++;
    this.#entries.clear();
    this.#flights.clear();
  }
  #start(key: string, load: (signal: AbortSignal) => Promise<T>): Flight<T> {
    const generation = this.#generation;
    const controller = new AbortController();
    const flight: Flight<T> = {
      controller,
      waiters: 0,
      settled: false,
      promise: load(controller.signal).then((value) => {
        if (generation === this.#generation) this.#keep(key, value);
        return value;
      }),
    };
    const done = () => {
      flight.settled = true;
      if (this.#flights.get(key) === flight) this.#flights.delete(key);
    };
    flight.promise.then(done, done);
    this.#flights.set(key, flight);
    return flight;
  }
  #keep(key: string, value: T): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, at: this.#now() });
    if (this.#entries.size > maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
  }
}

/** A repository's open-work lists, shared by every backend reading it under one identity. */
export class ForgeListCaches {
  readonly prs: ListCache<ForgePrList>;
  readonly issues: ListCache<ForgeIssueList>;
  readonly openWork: ListCache<ForgeOpenWork>;
  /** `@` completions by search; a write never changes who can be mentioned. */
  readonly people: ListCache<ForgePerson[]>;
  /** `#` completions by search. */
  readonly references: ListCache<ForgeReference[]>;
  constructor(now: () => number, freshMs = listFreshMs) {
    this.prs = new ListCache(now, freshMs);
    this.issues = new ListCache(now, freshMs);
    this.openWork = new ListCache(now, freshMs);
    this.people = new ListCache(now, freshMs * 5);
    this.references = new ListCache(now, freshMs);
  }
  /** A write may have changed any list: the next read of each asks GitHub. */
  invalidate(): void {
    this.prs.invalidate();
    this.issues.invalidate();
    this.openWork.invalidate();
    this.references.invalidate();
  }
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
