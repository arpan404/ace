/*
 * Check logs read page by page: a log is split into lines once and kept for its run, so the
 * phone asks only for the lines it is about to draw. A few runs are kept, the oldest going
 * first.
 */

export interface LogPage {
  type: "forge.log";
  from: number;
  lines: string[];
  total: number;
}

const keptLogs = 8;

export class LogPages {
  #logs = new Map<string | number, string[]>();

  has(key: string | number): boolean {
    return this.#logs.has(key);
  }

  keep(key: string | number, text: string): void {
    this.#logs.delete(key);
    this.#logs.set(key, text ? text.split("\n") : []);
    for (const old of this.#logs.keys()) {
      if (this.#logs.size <= keptLogs) break;
      this.#logs.delete(old);
    }
  }

  count(key: string | number): number {
    return this.#logs.get(key)?.length ?? 0;
  }

  page(key: string | number, from: number, count: number): LogPage {
    const lines = this.#logs.get(key) ?? [];
    return {
      type: "forge.log",
      from,
      // Very long lines are cut so one line never costs a page's worth of drawing.
      lines: lines.slice(from, from + count).map((line) => line.slice(0, 2_000)),
      total: lines.length,
    };
  }
}
