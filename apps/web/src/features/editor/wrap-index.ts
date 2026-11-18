/*
 * The visual rows of the whole open document: how many rows each line takes, where a line starts
 * in the rows, and which line a row belongs to. A Fenwick tree over the per-line counts keeps a
 * prefix sum that changes with an edit in logarithmic time, so a keystroke re-measures the lines
 * it touched and never the file; only a width change re-measures everything, a slice at a time.
 */

import type { LineEdit } from "@ace/editor";
import { wrapLine, type WrapRow } from "./wrap.ts";

/** The text the index wraps: the open document, asked one line at a time. */
export interface WrapText {
  lenLines(): number;
  line(index: number): string;
}

/** Where a document's visual rows sit, for the list, the carets and the pointer. */
export interface RowLayout {
  /** The visual row a line starts at. */
  startOf(line: number): number;
  /** The line a visual row belongs to. */
  lineAt(row: number): number;
  /** A line's rows; it touches the document's text and is meant for the lines on screen. */
  rowsOf(line: number): readonly WrapRow[];
  /** The document's visual rows. */
  total(): number;
}

/** Rows kept from earlier renders; a long scroll forgets the far end rather than growing. */
const cachedRows = 4_000;

export class WrapIndex implements RowLayout {
  readonly #text: WrapText;
  #columns = Number.POSITIVE_INFINITY;
  #counts: Uint32Array;
  /** 1 = the count is an estimate to re-measure at this width. */
  #dirty: Uint8Array;
  /** A Fenwick tree over the counts, one-based. */
  #tree: Int32Array;
  #total: number;
  #rows = new Map<number, readonly WrapRow[]>();
  #pending: number[] = [];
  #from = 0;
  #queued: Uint8Array;

  constructor(text: WrapText) {
    this.#text = text;
    const lines = Math.max(0, text.lenLines());
    this.#counts = new Uint32Array(lines).fill(1);
    this.#dirty = new Uint8Array(lines).fill(1);
    this.#queued = new Uint8Array(lines);
    this.#tree = new Int32Array(lines + 1);
    this.#total = lines;
    this.#buildTree();
  }

  /** The cells a line wraps at; `Infinity` leaves every line on one row. */
  get columns(): number {
    return this.#columns;
  }

  /**
   * Sets the wrap width. A new width re-measures `visible` at once, then queues the rest; the
   * same width changes nothing. Answers whether anything was queued.
   */
  setColumns(columns: number, visible?: { first: number; last: number }): boolean {
    const next = Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : Infinity;
    if (next === this.#columns) return false;
    this.#columns = next;
    this.#rows.clear();
    if (next === Infinity) {
      // Every line is one row: no text is read at all.
      this.#counts.fill(1);
      this.#dirty.fill(0);
      this.#tree = new Int32Array(this.#counts.length + 1);
      this.#buildTree();
      this.#pending = [];
      this.#from = 0;
      this.#queued.fill(0);
      return true;
    }
    this.#dirty.fill(1);
    this.#pending = [];
    this.#from = 0;
    this.#queued.fill(0);
    if (visible) this.prefer(visible);
    this.#queueDirty();
    return true;
  }

  /** Measures the lines on screen before the rest, after a width change. */
  prefer(range: { first: number; last: number }): void {
    const from = Math.max(0, range.first);
    const to = Math.min(this.#counts.length, range.last);
    for (let line = from; line < to; line++) if (this.#dirty[line]) this.#measure(line);
  }

  /** One row count per line is what `total` sums; a row past the end clamps to the last line. */
  startOf(line: number): number {
    const capped = Math.max(0, Math.min(line, this.#counts.length));
    return this.#sum(capped);
  }

  lineAt(row: number): number {
    const count = this.#counts.length;
    if (count === 0) return 0;
    const target = Math.max(0, Math.min(row, this.#total - 1));
    let line = 0;
    let seen = 0;
    let bit = 1;
    while (bit * 2 <= count) bit *= 2;
    for (; bit > 0; bit = Math.floor(bit / 2)) {
      const next = line + bit;
      if (next <= count && seen + this.#tree[next] <= target) {
        line = next;
        seen += this.#tree[next];
      }
    }
    return Math.min(line, count - 1);
  }

  total(): number {
    return this.#total;
  }

  /** The lines still to measure at this width; the view pumps these while it has idle time. */
  pending(): number {
    return this.#pending.length - this.#from;
  }

  rowsOf(line: number): readonly WrapRow[] {
    const known = this.#rows.get(line);
    if (known) return known;
    const rows = this.#measure(line);
    if (this.#rows.size >= cachedRows) this.#rows.clear();
    this.#rows.set(line, rows);
    return rows;
  }

  /**
   * An edit, in post-edit coordinates: the lines each span inserted are measured now (a handful
   * at most); lines that moved keep their counts.
   */
  apply(spans: readonly LineEdit[], lineCount: number): void {
    if (lineCount !== this.#counts.length) this.#remap(spans, lineCount);
    for (const span of spans) {
      const from = Math.max(0, span.firstLine);
      const to = Math.min(this.#counts.length, span.firstLine + Math.max(1, span.insertedLines));
      for (let line = from; line < to; line++) {
        this.#rows.delete(line);
        this.#measure(line);
      }
    }
  }

  /** Measures up to `limit` queued lines, visible ones first; answers how many remain. */
  pump(limit: number): number {
    let remaining = limit;
    while (this.#from < this.#pending.length && remaining > 0) {
      const line = this.#pending[this.#from++];
      if (line >= this.#counts.length) continue;
      this.#queued[line] = 0;
      if (!this.#dirty[line]) continue;
      this.#measure(line);
      remaining--;
    }
    if (this.#from >= this.#pending.length) {
      this.#pending = [];
      this.#from = 0;
    }
    return this.pending();
  }

  #measure(line: number): readonly WrapRow[] {
    const text = this.#text.line(line);
    const rows = wrapLine(text, this.#columns);
    this.#setCount(line, rows.length);
    this.#dirty[line] = 0;
    return rows;
  }

  #queueDirty(): void {
    for (let line = 0; line < this.#counts.length; line++) {
      if (!this.#dirty[line] || this.#queued[line]) continue;
      this.#queued[line] = 1;
      this.#pending.push(line);
    }
  }

  #setCount(line: number, count: number): void {
    const previous = this.#counts[line];
    if (previous === count) return;
    this.#counts[line] = count;
    this.#total += count - previous;
    for (let at = line + 1; at < this.#tree.length; at += at & -at) {
      this.#tree[at] += count - previous;
    }
  }

  #sum(line: number): number {
    let total = 0;
    for (let at = line; at > 0; at -= at & -at) total += this.#tree[at];
    return total;
  }

  #buildTree(): void {
    this.#tree.fill(0);
    this.#total = 0;
    const count = this.#counts.length;
    for (let line = 0; line < count; line++) {
      const value = this.#counts[line];
      this.#total += value;
      this.#tree[line + 1] += value;
      const parent = line + 1 + ((line + 1) & -(line + 1));
      if (parent <= count) this.#tree[parent] += this.#tree[line + 1];
    }
  }

  /** Line-count changes shift the counts of surviving lines; new lines start at one row. */
  #remap(spans: readonly LineEdit[], lineCount: number): void {
    const previousCounts = this.#counts;
    const previousDirty = this.#dirty;
    const counts = new Uint32Array(lineCount).fill(1);
    const dirty = new Uint8Array(lineCount).fill(1);
    let oldAt = 0;
    let newAt = 0;
    for (const span of spans) {
      const keep = Math.min(
        Math.max(0, span.firstLine - newAt),
        previousCounts.length - oldAt,
        lineCount - newAt,
      );
      if (keep <= 0) continue;
      counts.set(previousCounts.subarray(oldAt, oldAt + keep), newAt);
      dirty.set(previousDirty.subarray(oldAt, oldAt + keep), newAt);
      oldAt += keep;
      newAt += keep;
      oldAt += span.removedLines;
      newAt = span.firstLine + Math.max(1, span.insertedLines);
    }
    const rest = Math.max(0, Math.min(previousCounts.length - oldAt, lineCount - newAt));
    if (rest > 0) {
      counts.set(previousCounts.subarray(oldAt, oldAt + rest), newAt);
      dirty.set(previousDirty.subarray(oldAt, oldAt + rest), newAt);
    }
    this.#counts = counts;
    this.#dirty = dirty;
    this.#tree = new Int32Array(lineCount + 1);
    this.#queued = new Uint8Array(lineCount);
    this.#pending = [];
    this.#from = 0;
    this.#rows.clear();
    this.#buildTree();
    if (this.#columns !== Infinity) this.#queueDirty();
  }
}
