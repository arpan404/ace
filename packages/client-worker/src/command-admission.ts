import {
  ClientError,
  commandAdmissionError,
  defaultLimits,
  type CommandAdmissionEvidence,
  type Scheduler,
} from "@ace/client";
import { CommandAdmissionId, type TabMessage } from "./wire.ts";

/** Read-only refusal checks have their own bounded budget so a full RPC queue can recover. */
export class CommandAdmission {
  readonly #pending = new Map<
    number,
    {
      evidence: CommandAdmissionEvidence;
      reject(error: ClientError): void;
      cancel(): void;
    }
  >();
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
  refuse(commandId: string, evidence: CommandAdmissionEvidence): Promise<never> {
    if (!CommandAdmissionId.safeParse(commandId).success)
      return Promise.reject(new ClientError("protocol"));
    if (this.#closed) return Promise.reject(new ClientError("offline"));
    if (this.#pending.size >= defaultLimits.intents)
      return Promise.reject(new ClientError("limit"));
    const check = this.#id();
    return new Promise((_, reject) => {
      const cancel = this.#scheduler.set(this.#deadline, () => this.settle(check, "unknown"));
      this.#pending.set(check, { reject, cancel, evidence });
      this.#send({
        t: "command.admission",
        check,
        commandId,
        ...(evidence === "fresh" ? { freshness: "fresh" } : {}),
      });
    });
  }
  settle(check: number, outcome: "fresh" | "unsent" | "admitted" | "unknown"): void {
    const pending = this.#pending.get(check);
    if (!pending) return;
    this.#pending.delete(check);
    pending.cancel();
    pending.reject(
      commandAdmissionError(
        outcome === "fresh" ? pending.evidence : outcome === "unsent" ? "unknown" : outcome,
      ),
    );
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
