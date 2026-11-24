import type { MainSocket } from "./main-socket.ts";
import type { DeliveryRuntime } from "./delivery-runtime.ts";

export interface PreAuthLimits {
  /**
   * Unauthenticated sockets on the loopback listener. Every peer there shares one address,
   * and browser pages are already refused by the Origin check.
   */
  local: number;
  /** Unauthenticated sockets on the remote listener. */
  remote: number;
  /** The share of the remote budget one address may hold. */
  perAddress: number;
  /** A socket that has not authenticated by then is terminated. */
  helloMs: number;
}
/** Both budgets together stay well below the 256-socket cap, leaving room for real clients. */
export const defaultPreAuthLimits: PreAuthLimits = {
  local: 128,
  remote: 64,
  perAddress: 16,
  helloMs: 5_000,
};

type Listener = "local" | "remote";
interface Pending {
  listener: Listener;
  address: string;
  cancel: () => void;
}
/** A slot promised to an upgrade whose handshake is still on the wire. */
interface Held {
  listener: Listener;
  address: string;
}
function increment<K>(counts: Map<K, number>, key: K, by: number): void {
  const next = (counts.get(key) ?? 0) + by;
  if (next > 0) counts.set(key, next);
  else counts.delete(key);
}

/**
 * Anonymous sockets get their own small budget, per listener and per remote address, and a
 * hello deadline. Authenticated sockets leave it, so silent peers cannot hold every slot.
 *
 * A native upgrade takes a slot before its handshake finishes (`reserve`) and keeps it until the
 * socket is registered (`track`) or the upgrade is refused, abandoned or fails (`release`), so a
 * burst cannot be admitted against capacity that another handshake already took.
 */
export class PreAuthAdmission {
  private limits: PreAuthLimits;
  private delay: DeliveryRuntime["delay"];
  private listeners = new Map<Listener, number>();
  private addresses = new Map<string, number>();
  private pending = new Map<MainSocket, Pending>();
  private held = new Map<number, Held>();
  private nextReservation = 0;
  constructor(limits: Partial<PreAuthLimits>, delay: DeliveryRuntime["delay"]) {
    this.limits = { ...defaultPreAuthLimits, ...limits };
    this.delay = delay;
  }
  /** Slots promised to native upgrades whose socket is not registered yet. */
  get reserved(): number {
    return this.held.size;
  }
  admits(listener: Listener, address: string): boolean {
    return (
      (this.listeners.get(listener) ?? 0) < this.limits[listener] &&
      (listener === "local" || (this.addresses.get(address) ?? 0) < this.limits.perAddress)
    );
  }
  /**
   * Takes one pre-auth slot (and one socket slot) for an accepted upgrade, before its handshake
   * finishes. The number returned names it to `release` or `track`.
   */
  reserve(listener: Listener, address: string): number {
    const reservation = this.nextReservation++;
    increment(this.listeners, listener, 1);
    if (listener === "remote") increment(this.addresses, address, 1);
    this.held.set(reservation, { listener, address });
    return reservation;
  }
  /** Frees a reservation that never became a socket; an id this admission no longer holds is ignored. */
  release(reservation: number): void {
    const held = this.held.get(reservation);
    if (held === undefined) return;
    this.held.delete(reservation);
    increment(this.listeners, held.listener, -1);
    if (held.listener === "remote") increment(this.addresses, held.address, -1);
  }
  track(socket: MainSocket, listener: Listener, address: string, reservation?: number): void {
    let entry: Held | undefined;
    if (reservation !== undefined) {
      entry = this.held.get(reservation);
      if (entry !== undefined) this.held.delete(reservation);
    }
    if (entry === undefined) {
      increment(this.listeners, listener, 1);
      if (listener === "remote") increment(this.addresses, address, 1);
      entry = { listener, address };
    }
    const cancel = this.delay(() => {
      if (!this.pending.has(socket)) return;
      this.releaseSocket(socket);
      socket.terminate();
    }, this.limits.helloMs);
    this.pending.set(socket, { ...entry, cancel });
    socket.once("close", () => this.releaseSocket(socket));
  }
  /** The socket proved a credential and no longer counts against the anonymous budget. */
  authenticated(socket: MainSocket): void {
    this.releaseSocket(socket);
  }
  private releaseSocket(socket: MainSocket): void {
    const entry = this.pending.get(socket);
    if (!entry) return;
    this.pending.delete(socket);
    entry.cancel();
    increment(this.listeners, entry.listener, -1);
    if (entry.listener === "remote") increment(this.addresses, entry.address, -1);
  }
}
