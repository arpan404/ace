import { FILE_REQUESTS_PER_CONNECTION } from "@ace/protocol";
import { ClientError } from "./types.ts";

/*
 * One queue for every file read on a connection. The daemon admits FILE_REQUESTS_PER_CONNECTION
 * file requests at once per socket and answers BUSY past that, so readers that each pace
 * themselves (three editor groups opening big files together) can still overrun it. Every part
 * waits here for a slot instead: the focused file's parts go first, a file opened earlier goes
 * before one opened later, and a read whose signal aborts leaves the queue at once.
 */

/** Who is waiting for a read: the file in front of the person, one on screen, or a prefetch. */
export type ReadPriority = "focused" | "visible" | "background";
const rank: Record<ReadPriority, number> = { focused: 0, visible: 1, background: 2 };

/**
 * Slots kept free for the connection's other file requests (stats, uploads, downloads), which
 * share the daemon's limit but not this queue.
 */
const reserved = 2;
/** Waits before each retry of a read the daemon called BUSY; then the read fails. */
const busyBackoffMs = [100, 250, 500, 1000];

export interface ReadBudgetOptions {
  /** Reads in flight at once on the connection. */
  limit?: number;
  /** Resolves after `ms`, or rejects once `signal` aborts. */
  wait?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

export interface ReadTicket {
  /** Read once, then again in order; a priority that changes takes effect for later parts. */
  priority: () => ReadPriority;
  /** Orders reads of the same priority: an earlier file's parts before a later file's. */
  order: number;
  signal: AbortSignal | undefined;
}

interface Waiter extends ReadTicket {
  sequence: number;
  start: () => void;
}

export interface ReadBudget {
  /** A new file read's place in line. */
  ticket(priority: ReadPriority | (() => ReadPriority), signal?: AbortSignal): ReadTicket;
  /** Run one part when a slot is free, retrying a BUSY reply a few times with backoff. */
  run<T>(ticket: ReadTicket, part: () => Promise<T>): Promise<T>;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ClientError("aborted"));
    const abort = () => {
      clearTimeout(timer);
      reject(new ClientError("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

const isBusy = (error: unknown) =>
  error instanceof ClientError && error.code === "daemon" && error.message === "BUSY";

export function createReadBudget(options: ReadBudgetOptions = {}): ReadBudget {
  const limit = Math.max(1, options.limit ?? FILE_REQUESTS_PER_CONNECTION - reserved);
  const wait = options.wait ?? sleep;
  const waiting = new Set<Waiter>();
  let active = 0;
  let orders = 0;
  let sequence = 0;
  const next = (): Waiter | undefined => {
    let best: Waiter | undefined;
    let bestRank = Infinity;
    for (const waiter of waiting) {
      const each = rank[waiter.priority()];
      if (
        !best ||
        each < bestRank ||
        (each === bestRank &&
          (waiter.order < best.order ||
            (waiter.order === best.order && waiter.sequence < best.sequence)))
      ) {
        best = waiter;
        bestRank = each;
      }
    }
    return best;
  };
  const pump = () => {
    while (active < limit) {
      const waiter = next();
      if (!waiter) return;
      waiting.delete(waiter);
      active++;
      waiter.start();
    }
  };
  const slot = (ticket: ReadTicket): Promise<() => void> =>
    new Promise((resolve, reject) => {
      const signal = ticket.signal;
      if (signal?.aborted) return reject(new ClientError("aborted"));
      const abort = () => {
        waiting.delete(waiter);
        reject(new ClientError("aborted"));
      };
      const waiter: Waiter = {
        ...ticket,
        sequence: sequence++,
        start: () => {
          signal?.removeEventListener("abort", abort);
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            active--;
            pump();
          });
        },
      };
      signal?.addEventListener("abort", abort, { once: true });
      waiting.add(waiter);
      pump();
    });
  return {
    ticket(priority, signal) {
      return {
        priority: typeof priority === "function" ? priority : () => priority,
        order: orders++,
        signal,
      };
    },
    async run(ticket, part) {
      for (let attempt = 0; ; attempt++) {
        const release = await slot(ticket);
        try {
          return await part();
        } catch (error) {
          if (!isBusy(error) || attempt >= busyBackoffMs.length) throw error;
        } finally {
          release();
        }
        // The slot is free while this read backs off, so the daemon's queue can drain.
        await wait(busyBackoffMs[attempt] ?? 0, ticket.signal);
      }
    },
  };
}

const budgets = new WeakMap<object, ReadBudget>();

/**
 * The read budget of one connection (keyed by its client), made on first use. Options apply
 * only when this call makes it.
 */
export function readBudgetOf(client: object, options?: ReadBudgetOptions): ReadBudget {
  let budget = budgets.get(client);
  if (!budget) {
    budget = createReadBudget(options);
    budgets.set(client, budget);
  }
  return budget;
}
