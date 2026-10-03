import type { WebSocket } from "ws";
import type { DeliveryRuntime } from "./delivery-runtime.ts";

export interface PreAuthLimits {
  /** Sockets per listener that have not authenticated yet. */
  perListener: number;
  /** The share of that budget one remote address may hold. */
  perAddress: number;
  /** A socket that has not authenticated by then is terminated. */
  helloMs: number;
}
export const defaultPreAuthLimits: PreAuthLimits = {
  perListener: 64,
  perAddress: 16,
  helloMs: 5_000,
};

interface Pending {
  listener: string;
  address: string;
  cancel: () => void;
}
function increment(counts: Map<string, number>, key: string, by: number): void {
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
  private listeners = new Map<string, number>();
  private addresses = new Map<string, number>();
  private pending = new Map<WebSocket, Pending>();
  constructor(limits: Partial<PreAuthLimits>, delay: DeliveryRuntime["delay"]) {
    this.limits = { ...defaultPreAuthLimits, ...limits };
    this.delay = delay;
  }
  admits(listener: string, address: string): boolean {
    return (
      (this.listeners.get(listener) ?? 0) < this.limits.perListener &&
      (this.addresses.get(`${listener}\0${address}`) ?? 0) < this.limits.perAddress
    );
  }
  track(socket: WebSocket, listener: string, address: string): void {
    increment(this.listeners, listener, 1);
    increment(this.addresses, `${listener}\0${address}`, 1);
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
    increment(this.addresses, `${entry.listener}\0${entry.address}`, -1);
  }
}
