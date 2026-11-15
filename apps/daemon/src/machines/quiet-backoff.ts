/**
 * The wait between polls of something that rarely changes: `baseMs` after a poll that saw a
 * change, doubling after each poll that saw none, up to `capMs`. Pure: the caller says what each
 * poll saw.
 */
export class QuietBackoff {
  private baseMs: number;
  private capMs: number;
  private currentMs: number;
  constructor(baseMs: number, capMs: number) {
    this.baseMs = baseMs;
    this.capMs = Math.max(baseMs, capMs);
    this.currentMs = baseMs;
  }
  /** The wait before the next poll, after one that saw a change or not. */
  next(changed: boolean): number {
    this.currentMs = changed ? this.baseMs : Math.min(this.capMs, this.currentMs * 2);
    return this.currentMs;
  }
  /** Something new to watch: the next poll comes at the base pace. */
  reset(): void {
    this.currentMs = this.baseMs;
  }
  /** The wait before the next poll. */
  get waitMs(): number {
    return this.currentMs;
  }
}
