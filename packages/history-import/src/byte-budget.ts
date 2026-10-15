/**
 * Admits concurrent reads by the bytes they may decode, not by count. A task larger than
 * the whole budget still runs, alone, so one oversized reservation cannot deadlock a scan.
 * Waiters are served in order, so a large reservation is never starved by small ones.
 */
export class ByteBudget {
  private used = 0;
  private running = 0;
  private waiting: { bytes: number; admit: () => void }[] = [];
  private limit: number;
  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid byte budget");
    this.limit = limit;
  }
  async use<T>(bytes: number, task: () => Promise<T>): Promise<T> {
    const amount = Math.min(this.limit, Math.max(0, Math.ceil(bytes)));
    if (this.waiting.length || !this.fits(amount))
      await new Promise<void>((admit) => this.waiting.push({ bytes: amount, admit }));
    else this.take(amount);
    try {
      return await task();
    } finally {
      this.used -= amount;
      this.running--;
      this.drain();
    }
  }
  private fits(bytes: number): boolean {
    return this.running === 0 || this.used + bytes <= this.limit;
  }
  private take(bytes: number): void {
    this.used += bytes;
    this.running++;
  }
  private drain(): void {
    for (let next = this.waiting[0]; next && this.fits(next.bytes); next = this.waiting[0]) {
      this.waiting.shift();
      this.take(next.bytes);
      next.admit();
    }
  }
}
