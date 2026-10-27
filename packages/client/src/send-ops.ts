/*
 * One thing at a time per failed send: an edit being saved or a retry on its way. Each refuses
 * to start while the other runs; observers learn which runs, so a client greys the other control.
 * One per `ClientCore` (`client.sendOps`), shared by every screen on that client.
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

/** The send's newer attempt (`retrySend` saves one), which then stands for it. */
export const retryOf = (commandId: string) => `${commandId}:retry`;
