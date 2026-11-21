/**
 * Moved threads an earlier build marked cancelled at recovery though they had landed here
 * (ADR 0191): this machine owns each, but its sender may have taken the cancel and resumed the
 * thread there. Only the sender asking again shows it is still waiting; until then the thread's
 * first turn waits, and after `waitMs` without that it never starts here, so one thread never
 * runs on both machines. The rows stay `cancelled` meanwhile: that is the durable record, and a
 * restart waits again.
 */
export class UnconfirmedMoves {
  private waiting = new Map<string, ReturnType<typeof setTimeout>>();
  private waitMs: number;
  constructor(waitMs: number) {
    this.waitMs = waitMs;
  }
  /** Waits for the sender of `transferId`; `expired` runs if it never asks. */
  wait(transferId: string, expired: () => void): void {
    if (this.waiting.has(transferId)) return;
    const timer = setTimeout(() => {
      if (this.waiting.delete(transferId)) expired();
    }, this.waitMs);
    timer.unref?.();
    this.waiting.set(transferId, timer);
  }
  /** Every transfer still waiting for its sender: their files are kept. */
  ids(): string[] {
    return [...this.waiting.keys()];
  }
  has(transferId: string): boolean {
    return this.waiting.has(transferId);
  }
  /** The sender asked: true once, for a transfer that was waiting. */
  confirm(transferId: string): boolean {
    const timer = this.waiting.get(transferId);
    if (!timer) return false;
    clearTimeout(timer);
    this.waiting.delete(transferId);
    return true;
  }
  close(): void {
    for (const timer of this.waiting.values()) clearTimeout(timer);
    this.waiting.clear();
  }
}
