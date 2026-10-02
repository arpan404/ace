import { isIP } from "node:net";
import { LimitsSchema } from "./config.ts";
import type { Limits } from "./config.ts";
export type { Limits } from "./config.ts";
/** IPv4-mapped IPv6 shares IPv4's quota. IPv6 hosts share their /64 budget. */
export function ipKey(ip: string): string {
  const version = isIP(ip);
  if (version === 4) return "v4:" + ip;
  if (version !== 6) throw new Error("Invalid peer IP");
  let normalized = ip.toLowerCase().split("%")[0] ?? "";
  if (normalized.includes(".")) {
    const last = normalized.lastIndexOf(":");
    const tail = normalized
      .slice(last + 1)
      .split(".")
      .map(Number);
    const [a, b, c, d] = tail;
    if (a === undefined || b === undefined || c === undefined || d === undefined)
      throw new Error("Invalid mapped IP");
    normalized =
      normalized.slice(0, last + 1) +
      ((a << 8) | b).toString(16) +
      ":" +
      ((c << 8) | d).toString(16);
  }
  const [left = "", right] = normalized.split("::");
  const first = left === "" ? [] : left.split(":");
  const last = right === undefined || right === "" ? [] : right.split(":");
  const words =
    right === undefined
      ? first
      : [...first, ...Array<string>(8 - first.length - last.length).fill("0"), ...last];
  const n = words.map((value) => parseInt(value, 16));
  if (n.slice(0, 5).every((value) => value === 0) && n[5] === 65535) {
    const x = n[6],
      y = n[7];
    if (x === undefined || y === undefined) throw new Error("Invalid mapped IP");
    return `v4:${x >>> 8}.${x & 255}.${y >>> 8}.${y & 255}`;
  }
  return (
    "v6:" +
    n
      .slice(0, 4)
      .map((value) => value.toString(16))
      .join(":")
  );
}
export type PeerBudget = {
  readonly key: string;
  acquire(now: number): boolean;
  release(now: number): void;
  take(now: number): number;
};
type Entry = { connections: number; tokens: number; updated: number; seen: number };
/** Pure admission and token decisions. Inactive entries form an O(1) LRU. */
export class IpBudget {
  #entries = new Map<string, Entry>();
  #idle = new Map<string, Entry>();
  #limits: Limits;
  constructor(limits: Partial<Limits> = {}) {
    this.#limits = LimitsSchema.parse(limits);
  }
  /** Normalize once at connection admission, keeping address parsing off the frame hot path. */
  forPeer(ip: string): PeerBudget {
    const key = ipKey(ip);
    return {
      key,
      acquire: (now) => this.#acquire(key, now),
      release: (now) => this.#release(key, now),
      take: (now) => this.#take(key, now),
    };
  }
  acquire(ip: string, now: number): boolean {
    return this.#acquire(ipKey(ip), now);
  }
  release(ip: string, now: number): void {
    this.#release(ipKey(ip), now);
  }
  take(ip: string, now: number): number {
    return this.#take(ipKey(ip), now);
  }
  #acquire(key: string, now: number): boolean {
    let entry = this.#entries.get(key);
    if (!entry) {
      if (this.#entries.size >= this.#limits.maxIpEntries) {
        const oldest = this.#idle.keys().next();
        if (oldest.done) return false;
        this.#idle.delete(oldest.value);
        this.#entries.delete(oldest.value);
      }
      entry = { connections: 0, tokens: this.#limits.messageBurst, updated: now, seen: now };
      this.#entries.set(key, entry);
    }
    if (entry.connections >= this.#limits.maxConnectionsPerIp) return false;
    this.#idle.delete(key);
    entry.connections++;
    entry.seen = now;
    return true;
  }
  #release(key: string, now: number): void {
    const e = this.#entries.get(key);
    if (!e) return;
    e.connections = Math.max(0, e.connections - 1);
    if (e.connections === 0) {
      e.seen = now;
      this.#idle.delete(key);
      this.#idle.set(key, e);
    }
  }
  /** Returns zero after consuming a token, otherwise the delay until one is available. */
  #take(key: string, now: number): number {
    const e = this.#entries.get(key);
    if (!e) throw new Error("IP not admitted");
    e.tokens = Math.min(
      this.#limits.messageBurst,
      e.tokens + (Math.max(0, now - e.updated) * this.#limits.messagesPerSecond) / 1000,
    );
    e.updated = now;
    if (e.connections === 0) {
      this.#idle.delete(key);
      this.#idle.set(key, e);
    }
    if (e.tokens < 1) return Math.ceil(((1 - e.tokens) * 1000) / this.#limits.messagesPerSecond);
    e.tokens--;
    return 0;
  }
  sweep(now: number): void {
    for (const [key, e] of this.#idle) {
      if (now - e.seen <= 60000) break;
      this.#idle.delete(key);
      this.#entries.delete(key);
    }
  }
}
