import type { SuitId, SuitLiveReport } from "@ace/protocol/suits";

/*
 * The daemon's side of the live check (ADR 0150, "Shown perfectly"). After an agent's preview
 * or keep, the devices showing the Suit are asked to check it as rendered (`suitCheck`). This
 * collects their `suitReport`s for a bounded time:
 *
 * - each asked socket answers at most once, and only for the check and Suit it was asked;
 * - once every asked socket has answered, or the wait runs out, the reports go back;
 * - after the first report the rest get a short grace, so one slow or silent device (a phone
 *   that has no live check) doesn't hold the agent for the whole wait.
 *
 * No I/O: ids and timers come in. Sockets are whatever the caller uses to name them.
 */

export interface LiveCheckTimers {
  /** Runs `run` once after `ms`; the returned function cancels it. */
  after(ms: number, run: () => void): () => void;
}

export interface LiveCheckWait {
  /** The longest the agent waits for any report. */
  totalMs: number;
  /** How long the rest may take once one device has answered. */
  graceMs: number;
}

export const liveCheckWait: LiveCheckWait = { totalMs: 9000, graceMs: 1500 };

interface Pending {
  suitId: SuitId;
  asked: Set<unknown>;
  reports: SuitLiveReport[];
  finish(): void;
  cancelGrace: (() => void) | undefined;
}

export class SuitLiveChecks {
  readonly #pending = new Map<string, Pending>();
  readonly #id: () => string;
  readonly #timers: LiveCheckTimers;
  readonly #wait: LiveCheckWait;

  constructor(id: () => string, timers: LiveCheckTimers, wait: LiveCheckWait = liveCheckWait) {
    this.#id = id;
    this.#timers = timers;
    this.#wait = wait;
  }

  /**
   * Starts a check of `suitId`. `ask` sends `suitCheck` with the new id and returns the sockets
   * it reached. Resolves with the reports that came back in time (none when nobody answered).
   */
  run(
    suitId: SuitId,
    ask: (checkId: string) => readonly unknown[],
    signal: AbortSignal,
  ): Promise<SuitLiveReport[]> {
    const checkId = this.#id();
    return new Promise((resolve) => {
      let cancelTotal: (() => void) | undefined;
      const finish = () => {
        if (!this.#pending.has(checkId)) return;
        this.#pending.delete(checkId);
        cancelTotal?.();
        pending.cancelGrace?.();
        signal.removeEventListener("abort", finish);
        resolve(pending.reports);
      };
      const pending: Pending = {
        suitId,
        asked: new Set(),
        reports: [],
        finish,
        cancelGrace: undefined,
      };
      this.#pending.set(checkId, pending);
      if (signal.aborted) return finish();
      signal.addEventListener("abort", finish);
      for (const socket of ask(checkId)) pending.asked.add(socket);
      if (pending.asked.size === 0) return finish();
      cancelTotal = this.#timers.after(this.#wait.totalMs, finish);
    });
  }

  /** A `suitReport` from `socket`; ignored unless that socket was asked this check. */
  receive(socket: unknown, report: SuitLiveReport): void {
    const pending = this.#pending.get(report.checkId);
    if (!pending || pending.suitId !== report.suitId || !pending.asked.delete(socket)) return;
    pending.reports.push(report);
    if (pending.asked.size === 0) return pending.finish();
    pending.cancelGrace ??= this.#timers.after(this.#wait.graceMs, pending.finish);
  }

  /** A socket closed: the check stops waiting for it. */
  forget(socket: unknown): void {
    for (const pending of this.#pending.values()) {
      if (!pending.asked.delete(socket)) continue;
      if (pending.asked.size === 0) pending.finish();
    }
  }
}
