import type { StatementSync } from "node:sqlite";

/** Reserve ranges durably before publishing volatile events. Old builds also skip this high-water
 * mark, so the existing host_sequence format remains readable in both directions. */
export class StreamSequences {
  private cursor = 0;
  private reserved = 0;
  constructor(privateOptions: {
    statement(sql: string): StatementSync;
    commit(run: () => void): void;
  }) {
    this.options = privateOptions;
  }
  private readonly options;
  initialize(): void {
    this.cursor = Number(
      this.options.statement("SELECT seq FROM host_sequence WHERE id=1").get()?.seq,
    );
    this.reserved = this.cursor;
  }
  head(): number {
    const row = this.options
      .statement(`SELECT MAX(seq) AS seq FROM (
      SELECT MAX(seq) AS seq FROM events UNION ALL SELECT MAX(seq) AS seq FROM usage_deletions
    )`)
      .get();
    return Number(row?.seq ?? 0);
  }
  replaySafe(after: number): boolean {
    const head = this.head();
    if (after > head && after > this.reserved) throw new Error("Cursor ahead of log");
    return (
      after === 0 ||
      after === head ||
      !!this.options.statement("SELECT 1 FROM events WHERE seq=?").get(after)
    );
  }
  next(after: number): number {
    this.cursor = Math.max(this.cursor, after) + 1;
    if (!Number.isSafeInteger(this.cursor)) throw new Error("Sequence exhausted");
    return this.cursor;
  }
  prepare(events: number): void {
    if (this.cursor + events <= this.reserved) return;
    const through = this.cursor + Math.max(65536, events);
    if (!Number.isSafeInteger(through)) throw new Error("Sequence exhausted");
    this.options.commit(() => {
      this.options.statement("UPDATE host_sequence SET seq=MAX(seq,?) WHERE id=1").run(through);
    });
    this.reserved = through;
  }
}
