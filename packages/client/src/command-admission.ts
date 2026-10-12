import { ClientError } from "./types.ts";

/** Absence from a receipt-trimmed outbox is unavailable history, never proof of freshness. */
export type CommandAdmissionEvidence = "fresh" | "admitted" | "unknown";

/** Only the owning allocator can prove that a new ID has not been offered for dispatch. */
export function commandAdmissionError(evidence: CommandAdmissionEvidence): ClientError {
  return new ClientError(evidence === "fresh" ? "not_dispatched" : "limit");
}

export interface CommandAllocation {
  offer(): void;
  refusal(): ClientError;
  release(): void;
  releaseUnsent(): void;
}

/** Pure ownership shared by recording allocations and every explicit-ID admission path. */
export class CommandAdmissions {
  readonly #allocations = new Map<string, CommandAllocation>();
  readonly #offers = new Map<string, number>();
  readonly #limit: number;
  constructor(limit: number) {
    this.#limit = limit;
  }
  available(id: string): void {
    if (this.#allocations.has(id)) throw commandAdmissionError("unknown");
  }
  reserve(id: string): CommandAllocation {
    this.available(id);
    if (this.#offers.has(id) || this.#allocations.size + this.#offers.size >= this.#limit)
      throw commandAdmissionError("unknown");
    let active = true;
    let offered = false;
    const allocation: CommandAllocation = {
      offer: () => {
        if (!active || offered) throw commandAdmissionError("unknown");
        offered = true;
      },
      refusal: () => commandAdmissionError(active && !offered ? "fresh" : "unknown"),
      release: () => {
        if (!active) return;
        active = false;
        this.#allocations.delete(id);
      },
      releaseUnsent: () => {
        if (!offered) allocation.release();
      },
    };
    this.#allocations.set(id, allocation);
    return allocation;
  }
  startOffer(id: string): () => void {
    this.available(id);
    const count = this.#offers.get(id) ?? 0;
    if (!count && this.#allocations.size + this.#offers.size >= this.#limit)
      throw commandAdmissionError("unknown");
    this.#offers.set(id, count + 1);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const remaining = (this.#offers.get(id) ?? 1) - 1;
      if (remaining) this.#offers.set(id, remaining);
      else this.#offers.delete(id);
    };
  }
}
