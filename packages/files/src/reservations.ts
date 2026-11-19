/**
 * The paths a mutation is still proving, and the mutations that have to wait for it.
 *
 * A move's guard is verified after it lands, and verifying a folder walks its whole tree. That
 * walk must not run inside the daemon's mutation queue, where a huge folder would hold up every
 * other write; it runs outside, under a reservation on the paths the move touched. A mutation
 * whose paths overlap a held reservation waits for it, so nothing acts on a path whose version is
 * still being read, and a mutation elsewhere is never held up at all.
 */
export class PathReservations {
  private held: { paths: string[]; settled: Promise<void>; release: () => void }[] = [];

  /** Whether nothing is being proven right now. */
  get idle(): boolean {
    return this.held.length === 0;
  }

  /** A promise that settles once nothing is held. */
  async settled(): Promise<void> {
    while (this.held.length) await Promise.all(this.held.map((entry) => entry.settled));
  }

  /**
   * Takes a reservation on `paths`, waiting for any overlapping one to be released.
   *
   * The returned function releases it, exactly once, however it is called.
   */
  async reserve(paths: string[]): Promise<() => void> {
    const wanted = paths.filter((path) => path.length > 0);
    for (;;) {
      const blocking = this.held.filter((entry) => overlaps(entry.paths, wanted));
      if (!blocking.length) break;
      await Promise.all(blocking.map((entry) => entry.settled));
    }
    const { promise: settled, resolve: release } = Promise.withResolvers<void>();
    const entry = { paths: wanted, settled, release };
    this.held.push(entry);
    return () => {
      if (!this.held.includes(entry)) return;
      this.held = this.held.filter((other) => other !== entry);
      entry.release();
    };
  }
}

/** Whether two path sets cover one path or a folder of one. */
export function overlaps(left: string[], right: string[]): boolean {
  return left.some((one) => right.some((other) => within(one, other)));
}

/** Whether `one` names `other`, or a folder that holds it. */
export function within(one: string, other: string): boolean {
  if (one === other) return true;
  const [shorter, longer] = one.length < other.length ? [one, other] : [other, one];
  return longer.startsWith(shorter.endsWith("/") ? shorter : `${shorter}/`);
}
