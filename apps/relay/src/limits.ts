export type Limits = {
  maxConnectionsPerIp: number;
  maxConnections: number;
  messagesPerSecond: number;
  messageBurst: number;
  maxFrameSize: number;
  idleTimeoutMs: number;
  highWaterBytes: number;
  maxBufferedBytes: number;
};
export const defaultLimits: Limits = {
  maxConnectionsPerIp: 64,
  maxConnections: 1024,
  messagesPerSecond: 1000,
  messageBurst: 2000,
  maxFrameSize: 65535,
  idleTimeoutMs: 60000,
  highWaterBytes: 256 * 1024,
  maxBufferedBytes: 1024 * 1024,
};
export class IpLimits {
  #entries = new Map<string, { connections: number; tokens: number; updated: number }>();
  #limits: Limits;
  #now: () => number;
  constructor(limits: Limits, now: () => number) {
    this.#limits = limits;
    this.#now = now;
  }
  acquire(ip: string): boolean {
    let entry = this.#entries.get(ip);
    if (!entry) {
      if (this.#entries.size >= 4096) return false;
      entry = { connections: 0, tokens: this.#limits.messageBurst, updated: this.#now() };
      this.#entries.set(ip, entry);
    }
    if (entry.connections >= this.#limits.maxConnectionsPerIp || !this.message(ip)) return false;
    entry.connections++;
    return true;
  }
  release(ip: string): void {
    const e = this.#entries.get(ip);
    if (e) e.connections--;
  }
  message(ip: string): boolean {
    const e = this.#entries.get(ip);
    if (!e) return false;
    const now = this.#now();
    e.tokens = Math.min(
      this.#limits.messageBurst,
      e.tokens + (Math.max(0, now - e.updated) * this.#limits.messagesPerSecond) / 1000,
    );
    e.updated = now;
    if (e.tokens < 1) return false;
    e.tokens--;
    return true;
  }
  sweep(): void {
    for (const [ip, e] of this.#entries)
      if (e.connections === 0 && this.#now() - e.updated > 60000) this.#entries.delete(ip);
  }
}
