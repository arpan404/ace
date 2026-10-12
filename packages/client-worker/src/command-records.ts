import { ClientError, commandAdmissionError, defaultLimits } from "@ace/client";
import type { WorkerMessage } from "./wire.ts";

/** A worker-owned allocation cannot dispatch until its tab finishes recording the ID. */
export class CommandRecords {
  readonly #pending = new Map<number, { settle(ok: boolean): void }>();
  readonly #post: (message: WorkerMessage) => void;
  constructor(post: (message: WorkerMessage) => void) {
    this.#post = post;
  }
  record(call: number, commandId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.#pending.size >= defaultLimits.requests)
      return Promise.reject(commandAdmissionError("fresh"));
    if (this.#pending.has(call)) return Promise.reject(new ClientError("protocol"));
    return new Promise((resolve, reject) => {
      const abort = () => this.settle(call, false);
      this.#pending.set(call, {
        settle: (ok) => {
          signal.removeEventListener("abort", abort);
          if (ok) resolve();
          else reject(commandAdmissionError("fresh"));
        },
      });
      signal.addEventListener("abort", abort, { once: true });
      this.#post({ t: "command.allocated", call, commandId });
    });
  }
  settle(call: number, ok: boolean): void {
    const pending = this.#pending.get(call);
    this.#pending.delete(call);
    pending?.settle(ok);
  }
}
