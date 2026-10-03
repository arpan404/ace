/**
 * In-memory partitions for ephemeral browser sessions. Electron keeps every `Session` it makes
 * for the app's lifetime (`session.fromPartition`), each with its own network context in the
 * network service, so a fresh partition per session would grow with every session an agent
 * ever opened. Partitions are reused instead, under two rules:
 * - a partition is lent to one session at a time, so open sessions never share one;
 * - a returned partition is lent again only after all its data was cleared; one whose
 *   clearing failed is retired and never lent again.
 * The pool therefore holds at most as many partitions as sessions were ever open at once
 * (eight, the relay's limit), plus any retired ones.
 */
export class PartitionPool {
  private prefix: string;
  private free: string[] = [];
  private lent = new Set<string>();
  private made = 0;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  /** A partition no open session uses and that holds no earlier session's data. */
  acquire(): string {
    const partition = this.free.pop() ?? `${this.prefix}${this.made++}`;
    this.lent.add(partition);
    return partition;
  }

  /** The session using `partition` closed; `cleared` says whether its data is gone. */
  release(partition: string, cleared: boolean): void {
    if (!this.lent.delete(partition)) return;
    if (cleared) this.free.push(partition);
  }

  /** Partitions made so far (each one a Session Electron keeps alive). */
  size(): number {
    return this.made;
  }
}
