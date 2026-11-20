/** Named one-shot deadlines on an injected scheduler; arming a key again replaces its timer. */
export class Deadlines {
  readonly #schedule: (delay: number, run: () => void) => () => void;
  readonly #cancels = new Map<string, () => void>();
  constructor(schedule: (delay: number, run: () => void) => () => void) {
    this.#schedule = schedule;
  }
  arm(key: string, delay: number, run: () => void): void {
    this.clear(key);
    const cancel = this.#schedule(delay, () => {
      if (this.#cancels.get(key) !== cancel) return;
      this.#cancels.delete(key);
      run();
    });
    this.#cancels.set(key, cancel);
  }
  has(key: string): boolean {
    return this.#cancels.has(key);
  }
  clear(key: string): void {
    this.#cancels.get(key)?.();
    this.#cancels.delete(key);
  }
  clearAll(): void {
    for (const cancel of this.#cancels.values()) cancel();
    this.#cancels.clear();
  }
}
