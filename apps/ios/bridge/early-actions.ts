import { z } from "zod";

/*
 * What native sends before the bridge's client exists (`aceStart` hasn't run yet, as at a cold
 * launch while the runtime boots): held instead of refused, and replayed in order once the client
 * is there, so a thread opened at launch is never dropped with the error alert. Only the latest
 * open of each thread is kept; a command still answers at once with its own refusal. Pure.
 */

const Shape = z.looseObject({ type: z.string(), threadId: z.string().optional() });

interface Held {
  type: string;
  threadId: string | undefined;
  raw: unknown;
}

export class EarlyActions {
  readonly #limit: number;
  #held: Held[] = [];

  constructor(limit = 128) {
    this.#limit = limit;
  }

  /**
   * Holds `raw` for the client. False for what isn't held: anything that isn't an action, a
   * command (its admission answers it now) and the read-ahead switch (kept on its own).
   */
  hold(raw: unknown): boolean {
    const shape = Shape.safeParse(raw);
    if (!shape.success) return false;
    const { type, threadId } = shape.data;
    if (type === "command" || type === "readAhead") return false;
    if (type === "open")
      this.#held = this.#held.filter((held) => held.type !== "open" || held.threadId !== threadId);
    this.#held.push({ type, threadId, raw });
    if (this.#held.length > this.#limit) {
      // Past the bound the oldest goes, an open last: the thread on screen must still open.
      const oldest = this.#held.findIndex((held) => held.type !== "open");
      this.#held.splice(Math.max(0, oldest), 1);
    }
    return true;
  }

  /** Everything held, oldest first; nothing is held after. */
  take(): unknown[] {
    const held = this.#held.map((entry) => entry.raw);
    this.#held = [];
    return held;
  }
}
