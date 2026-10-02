import { ExpiryMap } from "./expiry-map.ts";

export interface TicketLimits {
  global: number;
  perDevice: number;
  perMinute: number;
}
export const defaultTicketLimits: Readonly<TicketLimits> = {
  global: 10_000,
  perDevice: 32,
  perMinute: 120,
};

/** Pure allocation policy. Its owner supplies time, identity and hashed ticket keys. */
export class TicketPool {
  private tickets = new ExpiryMap<{ deviceId: string; expiresAt: number }>();
  private owned = new Map<string, Set<string>>();
  private rates = new ExpiryMap<{ count: number; resetsAt: number }>();
  private limits: TicketLimits;
  constructor(limits: TicketLimits) {
    this.limits = limits;
  }
  issue(key: string, deviceId: string, now: number): { expiresAt: number } | { error: string } {
    this.evict(now);
    if (this.tickets.size >= this.limits.global) return { error: "Too many pending tickets" };
    if ((this.owned.get(deviceId)?.size ?? 0) >= this.limits.perDevice)
      return { error: "Device ticket quota exceeded" };
    const rate = this.rates.get(deviceId) ?? { count: 0, resetsAt: now + 60_000 };
    if (
      rate.count >= this.limits.perMinute ||
      (!this.rates.get(deviceId) && this.rates.size >= this.limits.global)
    )
      return { error: "Device ticket rate limit exceeded" };
    rate.count++;
    this.rates.set(deviceId, rate, rate.resetsAt);
    const expiresAt = now + 60_000;
    this.tickets.set(key, { deviceId, expiresAt }, expiresAt);
    const keys = this.owned.get(deviceId) ?? new Set<string>();
    keys.add(key);
    this.owned.set(deviceId, keys);
    return { expiresAt };
  }
  consume(key: string, now: number): string | undefined {
    this.evict(now);
    const entry = this.tickets.delete(key);
    if (!entry) return undefined;
    this.disown(entry.deviceId, key);
    return entry.deviceId;
  }
  revoke(deviceId: string): void {
    const keys = this.owned.get(deviceId);
    if (keys) for (const key of keys) this.tickets.delete(key);
    this.owned.delete(deviceId);
    this.rates.delete(deviceId);
  }
  private evict(now: number): void {
    for (const { key, value } of this.tickets.expire(now)) this.disown(value.deviceId, key);
    for (const expired of this.rates.expire(now)) {
      void expired;
    }
  }
  private disown(deviceId: string, key: string): void {
    const keys = this.owned.get(deviceId);
    keys?.delete(key);
    if (keys?.size === 0) this.owned.delete(deviceId);
  }
}
