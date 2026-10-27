/*
 * Which background command jobs this machine still remembers (ADR 0105). Pure bookkeeping: the
 * caller passes the time. A running job is always kept; a finished one keeps up to 2 MB of
 * output, so finished jobs are kept only for a while and only a few at a time.
 */

/** Finished jobs one calling thread keeps to read, and all calling threads together. */
export const keptPerSession = 8;
export const keptInAll = 32;
/** How long a finished job stays readable. */
export const keptForMs = 30 * 60 * 1000;

export interface JobEntry {
  id: string;
  /** The guest session thread the job belongs to. */
  session: string;
  /** When it finished; unset while it runs. */
  endedAt?: number;
}

export class CommandJobs<T extends JobEntry> {
  private jobs = new Map<string, T>();
  add(job: T): void {
    this.jobs.set(job.id, job);
  }
  get(id: string): T | undefined {
    return this.jobs.get(id);
  }
  /** Jobs of one session still running. */
  running(session: string): T[] {
    return [...this.jobs.values()].filter(
      (job) => job.session === session && job.endedAt === undefined,
    );
  }
  /** Every job still running, in any session. */
  live(): T[] {
    return [...this.jobs.values()].filter((job) => job.endedAt === undefined);
  }
  /** A job ended at `at`; older finished ones over the bounds are dropped. */
  finished(id: string, at: number): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.endedAt = at;
    this.prune(at);
  }
  /**
   * Drops finished jobs older than `keptForMs`, then the oldest finished ones beyond
   * `keptPerSession` per session and `keptInAll` in all.
   */
  prune(now: number): void {
    const done = [...this.jobs.values()]
      .filter((job) => job.endedAt !== undefined)
      .toSorted((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    const perSession = new Map<string, number>();
    let kept = 0;
    for (const job of done) {
      const count = perSession.get(job.session) ?? 0;
      if (now - (job.endedAt ?? now) > keptForMs || count >= keptPerSession || kept >= keptInAll) {
        this.jobs.delete(job.id);
        continue;
      }
      perSession.set(job.session, count + 1);
      kept++;
    }
  }
  /** The session was deleted: none of its jobs is kept, running or not. */
  forget(session: string): T[] {
    const gone = [...this.jobs.values()].filter((job) => job.session === session);
    for (const job of gone) this.jobs.delete(job.id);
    return gone;
  }
}
