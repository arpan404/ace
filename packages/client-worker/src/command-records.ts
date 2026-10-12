import { ClientError, defaultLimits } from "@ace/client";
import type { WorkerMessage } from "./wire.ts";

/** Core owns the reservation and certainty; this shell reports recording outcomes only. */
export class CommandRecords {
  readonly #pending = new Map<number, { settle(ok: boolean): void }>();
  readonly #post: (message: WorkerMessage) => void;
  constructor(post: (message: WorkerMessage) => void) {
    this.#post = post;
  }
  record(call: number, commandId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.#pending.size >= defaultLimits.requests)
      return Promise.reject(new ClientError("storage"));
    if (this.#pending.has(call)) return Promise.reject(new ClientError("protocol"));
    return new Promise((resolve, reject) => {
      const abort = () => this.settle(call, false);
      this.#pending.set(call, {
        settle: (ok) => {
          signal.removeEventListener("abort", abort);
          if (ok) resolve();
          else reject(new ClientError("storage"));
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
