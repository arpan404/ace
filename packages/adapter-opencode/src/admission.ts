type Waiter = {
  resolve(release: () => void): void;
  reject(error: Error): void;
  signal: AbortSignal;
  abort(): void;
};
/** Serialize HTTP admission only. The engine and native inbox still own work queues. */
export class AdmissionQueue {
  private active = false;
  private waiting: Waiter[] = [];
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.waiting.length >= 64) throw new Error("OpenCode admission waiter limit");
    if (!this.active) {
      this.active = true;
      return () => this.release();
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new Error("OpenCode admission cancelled"));
        },
      };
      this.waiting.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
    });
  }
  private release(): void {
    const next = this.waiting.shift();
    if (!next) {
      this.active = false;
      return;
    }
    next.signal.removeEventListener("abort", next.abort);
    next.resolve(() => this.release());
  }
}
