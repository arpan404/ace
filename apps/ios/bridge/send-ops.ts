/*
 * One thing at a time per failed send: an edit being saved or a retry on its way. Each refuses
 * to start while the other runs, and the send's row says which runs, so the phone greys the other
 * control. Pure state; the inbox re-sends the row when it changes.
 */

export type SendOp = "editing" | "retrying";

export class SendOps {
  readonly #running = new Map<string, SendOp>();
  readonly #listeners = new Set<(commandId: string) => void>();

  /** Called with the send's id whenever what runs on it changes. */
  observe(listener: (commandId: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #changed(commandId: string): void {
    for (const listener of this.#listeners) listener(commandId);
  }

  current(commandId: string): SendOp | undefined {
    return this.#running.get(commandId);
  }

  /** Runs `work` as `op` on the send, or answers false at once when another runs on it. */
  async run<T>(
    commandId: string,
    op: SendOp,
    work: () => Promise<T>,
  ): Promise<{ ran: true; value: T } | { ran: false; running: SendOp }> {
    const running = this.#running.get(commandId);
    if (running) return { ran: false, running };
    this.#running.set(commandId, op);
    this.#changed(commandId);
    try {
      return { ran: true, value: await work() };
    } finally {
      this.#running.delete(commandId);
      this.#changed(commandId);
    }
  }
}

/** Why the other control waits, in the phone's words. */
export function sendBusy(running: SendOp): string {
  return running === "retrying"
    ? "It's being sent again. Edit it if that fails."
    : "Its edit is being saved. Try again once it's saved.";
}

/** The send's newer attempt (Retry saves one), which the row now stands for. */
export const retryOf = (commandId: string) => `${commandId}:retry`;
