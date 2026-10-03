import type { WebSocket } from "ws";
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
function increment<K>(counts: Map<K, number>, key: K, by: number): void {
  const next = (counts.get(key) ?? 0) + by;
  if (next > 0) counts.set(key, next);
  else counts.delete(key);
}

/**
 * Anonymous sockets get their own small budget, per listener and per remote address, and a
 * hello deadline. Authenticated sockets leave it, so silent peers cannot hold every slot.
 */
export class PreAuthAdmission {
  private limits: PreAuthLimits;
  private delay: DeliveryRuntime["delay"];
  private listeners = new Map<Listener, number>();
  private addresses = new Map<string, number>();
  private pending = new Map<WebSocket, Pending>();
  constructor(limits: Partial<PreAuthLimits>, delay: DeliveryRuntime["delay"]) {
    this.limits = { ...defaultPreAuthLimits, ...limits };
    this.delay = delay;
  }
  admits(listener: Listener, address: string): boolean {
    return (
      (this.listeners.get(listener) ?? 0) < this.limits[listener] &&
      (listener === "local" || (this.addresses.get(address) ?? 0) < this.limits.perAddress)
    );
  }
  track(socket: WebSocket, listener: Listener, address: string): void {
    increment(this.listeners, listener, 1);
    if (listener === "remote") increment(this.addresses, address, 1);
    const cancel = this.delay(() => {
      if (!this.pending.has(socket)) return;
      this.release(socket);
      socket.terminate();
    }, this.limits.helloMs);
    this.pending.set(socket, { listener, address, cancel });
    socket.once("close", () => this.release(socket));
  }
  /** The socket proved a credential and no longer counts against the anonymous budget. */
  authenticated(socket: WebSocket): void {
    this.release(socket);
  }
  private release(socket: WebSocket): void {
    const entry = this.pending.get(socket);
    if (!entry) return;
    this.pending.delete(socket);
    entry.cancel();
    increment(this.listeners, entry.listener, -1);
    if (entry.listener === "remote") increment(this.addresses, entry.address, -1);
  }
}
