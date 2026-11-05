/**
 * Who may close a descriptor number, and when. Pure bookkeeping for the lanes.
 *
 * - A call pins the descriptors it names from when it is queued until it has returned natively.
 *   A close of a pinned descriptor waits until the last pin is gone.
 * - Owned descriptors are ones the lanes are responsible for: handed to openDirectory (then
 *   owned by its stream), or with a close asked for and not yet done. A number stays owned until
 *   its native close has returned, so a second close of it is ignored rather than hitting a
 *   number some other thread has reused.
 */
export class DescriptorLedger {
  private readonly pins = new Map<number, number>();
  private readonly deferred = new Map<number, string>();
  private readonly owned = new Set<number>();

  pin(fds: readonly number[]): void {
    for (const fd of fds) this.pins.set(fd, (this.pins.get(fd) ?? 0) + 1);
  }
  /** Drops the pins; returns the closes, with their roots, that were waiting on them. */
  unpin(fds: readonly number[]): { root: string; fd: number }[] {
    const ready: { root: string; fd: number }[] = [];
    for (const fd of fds) {
      const left = (this.pins.get(fd) ?? 1) - 1;
      if (left > 0) {
        this.pins.set(fd, left);
        continue;
      }
      this.pins.delete(fd);
      const root = this.deferred.get(fd);
      if (root === undefined) continue;
      this.deferred.delete(fd);
      ready.push({ root, fd });
    }
    return ready;
  }
  owns(fd: number): boolean {
    return this.owned.has(fd);
  }
  /** Takes responsibility for closing `fd`; false if the lanes already have it. */
  take(fd: number): boolean {
    if (this.owned.has(fd)) return false;
    this.owned.add(fd);
    return true;
  }
  /** The native close of `fd` has returned (or its owner did it): the number is free. */
  closed(fd: number): void {
    this.owned.delete(fd);
  }
  /** Whether an owned descriptor's close may run now; if pinned, it waits for `unpin`. */
  closable(root: string, fd: number): boolean {
    if (!this.pins.has(fd)) return true;
    this.deferred.set(fd, root);
    return false;
  }
}
