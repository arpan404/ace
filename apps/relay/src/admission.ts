/** Pending Noise and device-authentication slots may be evicted; authorized devices may not. */
export class ClientSlots {
  #slots = new Map<string, "pending" | "authorized">();
  #limit: number;
  constructor(limit: number) {
    this.#limit = limit;
  }
  reserve(id: string): { accepted: boolean; evicted?: string } {
    let evicted: string | undefined;
    if (this.#slots.size >= this.#limit) {
      for (const [old, state] of this.#slots)
        if (state === "pending") {
          evicted = old;
          this.#slots.delete(old);
          break;
        }
      if (!evicted) return { accepted: false };
    }
    this.#slots.set(id, "pending");
    return { accepted: true, ...(evicted ? { evicted } : {}) };
  }
  authorize(id: string): void {
    if (!this.#slots.has(id)) throw new Error("Channel expired");
    this.#slots.set(id, "authorized");
  }
  release(id: string): void {
    this.#slots.delete(id);
  }
}
