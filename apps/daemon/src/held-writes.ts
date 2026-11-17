/**
 * Bookkeeping writes that failed (a full disk, ADR 0176) and must not be lost: each waits in
 * memory under a key and runs again on the owner's next pass, in the order it was first held.
 * Every write held here must be idempotent ("mark this thread due"), so running it late, or
 * once more than needed, changes nothing. A later write under the same key replaces the held
 * one. Held writes die with the process; each owner's start-up pass already marks every
 * thread, so a crash loses none of their intent.
 */
export class HeldWrites {
  private held = new Map<string, () => void>();
  private report: (error: unknown) => void;
  constructor(report: (error: unknown) => void) {
    this.report = report;
  }
  /** Run `write` now. If it throws, it is held under `key` for `flush`. Never throws. */
  run(key: string, write: () => void): boolean {
    try {
      write();
      this.held.delete(key);
      return true;
    } catch (error) {
      this.held.delete(key);
      this.held.set(key, write);
      this.report(error);
      return false;
    }
  }
  /** Run every held write, oldest first; true once none is held. Never throws. */
  flush(): boolean {
    for (const [key, write] of this.held) {
      try {
        write();
      } catch (error) {
        this.report(error);
        return false;
      }
      this.held.delete(key);
    }
    return true;
  }
}
