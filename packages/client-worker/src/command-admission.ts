import { ClientError, defaultLimits, type Scheduler } from "@ace/client";
import { CommandAdmissionId, type TabMessage } from "./wire.ts";

/** Read-only refusal checks have their own bounded budget so a full RPC queue can recover. */
export class CommandAdmission {
  readonly #pending = new Map<number, { reject(error: ClientError): void; cancel(): void }>();
  readonly #send: (message: TabMessage) => void;
  readonly #id: () => number;
  readonly #scheduler: Scheduler;
  readonly #deadline: number;
  #closed = false;
  constructor(
    send: (message: TabMessage) => void,
    id: () => number,
    scheduler: Scheduler,
    deadline: number,
  ) {
    this.#send = send;
    this.#id = id;
    this.#scheduler = scheduler;
    this.#deadline = deadline;
  }
  refuse(commandId: string): Promise<never> {
    if (!CommandAdmissionId.safeParse(commandId).success)
      return Promise.reject(new ClientError("protocol"));
    if (this.#closed) return Promise.reject(new ClientError("offline"));
    if (this.#pending.size >= defaultLimits.intents)
      return Promise.reject(new ClientError("limit"));
    const check = this.#id();
    return new Promise((_, reject) => {
      const cancel = this.#scheduler.set(this.#deadline, () => this.settle(check, "unknown"));
      this.#pending.set(check, { reject, cancel });
      this.#send({ t: "command.admission", check, commandId });
    });
  }
  settle(check: number, outcome: "unsent" | "admitted" | "unknown"): void {
    const pending = this.#pending.get(check);
    if (!pending) return;
    this.#pending.delete(check);
    pending.cancel();
    // Only the worker owning the initialized outbox can establish absence of an earlier intent.
    pending.reject(new ClientError(outcome === "unsent" ? "not_dispatched" : "limit"));
  }
  close(): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      pending.cancel();
      pending.reject(new ClientError("offline"));
    }
    this.#pending.clear();
  }
}
