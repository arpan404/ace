import type { MaintenanceGate } from "@ace/service";

/**
 * How long an update's hold on admission lasts without being renewed. A drain renews it on every
 * poll (about once a second), so this is many missed polls: the app or CLI that drained has
 * crashed or been interrupted, and new work must be able to start again on its own.
 */
export const updateLeaseMs = 45_000;

export interface UpdateHoldClock {
  /** Runs `callback` after `ms`; returns the cancel. */
  delay(callback: () => void, ms: number): () => void;
}

/**
 * The `update` hold on the maintenance gate as a lease. A drain takes and renews it over the
 * loopback route; it ends when the drain lets go or stops renewing. A daemon started in the
 * middle of an update (`ACE_MAINTENANCE=1`, ADR 0041) holds it until `ace update recover`, with
 * no lease, since its journal still needs recovering.
 */
export class UpdateHold {
  readonly #gate: MaintenanceGate;
  readonly #clock: UpdateHoldClock;
  readonly #leaseMs: number;
  #cancel: (() => void) | undefined;
  #persistent = false;
  constructor(gate: MaintenanceGate, clock: UpdateHoldClock, leaseMs = updateLeaseMs) {
    this.#gate = gate;
    this.#clock = clock;
    this.#leaseMs = leaseMs;
  }
  /** Takes or renews the lease; returns admission as it now stands. */
  renew() {
    this.#gate.enter("update");
    this.#cancel?.();
    this.#cancel = this.#persistent
      ? undefined
      : this.#clock.delay(() => this.#expire(), this.#leaseMs);
    return this.#gate.status();
  }
  /** Holds until released, for a daemon that started mid-update. */
  persist(): void {
    this.#persistent = true;
    this.#cancel?.();
    this.#cancel = undefined;
    this.#gate.enter("update");
  }
  release() {
    this.#persistent = false;
    this.#cancel?.();
    this.#cancel = undefined;
    return this.#gate.leave("update");
  }
  close(): void {
    this.#cancel?.();
    this.#cancel = undefined;
  }
  #expire(): void {
    this.#cancel = undefined;
    if (!this.#persistent) this.#gate.leave("update");
  }
}
