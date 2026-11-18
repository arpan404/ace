/*
 * The visual rows of the whole open document: a row count for every line in an implicit treap,
 * so a line's start row, the line a row belongs to, and an edit that inserts or removes lines
 * all cost logarithmic time instead of a walk over the file.
 *
 * A width change re-measures the lines on screen at once and spreads the rest over slices, a
 * line's text change re-measures only the lines its span covers, and the counts keep their old
 * values as estimates until then, so the scroll height never collapses in between.
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

/** The spans of one applied edit, and the document's line count after it. */
export interface LineBatch {
  spans: readonly LineEdit[];
  lines: number;
}

/** Rows kept from earlier renders; a long scroll forgets the far end rather than growing. */
const cachedRows = 4_000;

/** Spans this long wait for the background pass instead of measuring inside a layout effect. */
const measuredNow = 200;

/** A deterministic priority for a new node: well spread, and never `Math.random`. */
function priority(seed: number): number {
  let value = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  value ^= value >>> 13;
  value = Math.imul(value, 0xc2b2ae35);
  value ^= value >>> 16;
  return value >>> 0;
}

export class WrapIndex implements RowLayout {
  readonly #text: WrapText;
  #columns = Number.POSITIVE_INFINITY;
  #rows = new Map<number, readonly WrapRow[]>();
  #pending: number[] = [];
  #from = 0;
  #dirtyCount = 0;

  // The implicit treap, 1-based: node 0 is the empty tree. Its in-order walk is the document.
  #left = new Int32Array(64);
  #right = new Int32Array(64);
  /** Nodes in this subtree, this one included. */
  #size = new Int32Array(64);
  /** This line's rows. */
  #count = new Int32Array(64);
  /** Rows in this subtree, this one included. */
  #sum = new Int32Array(64);
  /** 1 = the count is an estimate to re-measure at this width. */
  #dirty = new Uint8Array(64);
  #queued = new Uint8Array(64);
  #priority = new Uint32Array(64);
  #root = 0;
  #used = 0;
  #seed = 0;
  #free: number[] = [];

  constructor(text: WrapText) {
    this.#text = text;
    this.#root = this.#build(Math.max(0, text.lenLines()));
  }

  /** The cells a line wraps at; `Infinity` leaves every line on one row. */
  get columns(): number {
    return this.#columns;
  }

  /**
   * Sets the wrap width. A new width re-measures `visible` at once, then queues the rest; the
   * same width changes nothing.
   */
  setColumns(columns: number, visible?: { first: number; last: number }): boolean {
    const next = Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : Infinity;
    if (next === this.#columns) return false;
    this.#columns = next;
    this.#rows.clear();
    this.#pending = [];
    this.#from = 0;
    if (next === Infinity) {
      // Every line is one row: no text is read at all.
      this.#walk((node) => {
        this.#count[node] = 1;
        this.#dirty[node] = 0;
        this.#sum[node] = this.#sizeOf(node);
      });
      this.#dirtyCount = 0;
      return true;
    }
    this.#walk((node) => {
      this.#dirty[node] = 1;
    });
    this.#dirtyCount = this.#length;
    if (visible) this.prefer(visible);
    this.#queueDirty();
    return true;
  }

  /** Measures the lines on screen before the rest, after a width change. */
  prefer(range: { first: number; last: number }): void {
    const from = Math.max(0, range.first);
    const to = Math.min(this.#length, range.last);
    for (let line = from; line < to; line++) if (this.#isDirty(line)) this.#measure(line);
  }

  startOf(line: number): number {
    let node = this.#root;
    let index = Math.max(0, Math.min(line, this.#length));
    let total = 0;
    while (node && index > 0) {
      const left = this.#leftOf(node);
      const leftSize = this.#sizeOf(left);
      if (index <= leftSize) {
        node = left;
        continue;
      }
      total += this.#sumOf(left);
      if (index === leftSize + 1) return total + this.#countOf(node);
      total += this.#countOf(node);
      index -= leftSize + 1;
      node = this.#rightOf(node);
    }
    return total;
  }

  lineAt(row: number): number {
    const length = this.#length;
    if (length === 0) return 0;
    let remaining = Math.max(0, Math.min(row, this.#sumOf(this.#root) - 1));
    let node = this.#root;
    let index = 0;
    while (node) {
      const left = this.#leftOf(node);
      const leftSize = this.#sizeOf(left);
      const leftSum = this.#sumOf(left);
      if (remaining < leftSum) {
        node = left;
        continue;
      }
      remaining -= leftSum;
      if (remaining < this.#countOf(node)) return index + leftSize;
      remaining -= this.#countOf(node);
      index += leftSize + 1;
      node = this.#rightOf(node);
    }
    return Math.min(index, length - 1);
  }

  total(): number {
    return this.#sumOf(this.#root);
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
   * Edits, one batch per applied edit, each in its own coordinate system. A batch whose spans
   * add or remove lines restructures the tree; every batch re-measures the lines it inserted,
   * or queues a span as long as the file for the background pass.
   */
  apply(batches: readonly LineBatch[]): void {
    for (const batch of batches) {
      if (batch.spans.some((span) => span.removedLines !== span.insertedLines)) {
        this.#restructure(batch.spans);
      }
      for (const span of batch.spans) this.#measureSpan(span);
    }
  }

  /** Measures up to `limit` queued lines; answers how many remain. */
  pump(limit: number): number {
    let remaining = limit;
    while (this.#from < this.#pending.length && remaining > 0) {
      const line = this.#pending[this.#from++];
      if (line === undefined) continue;
      if (!this.#isDirty(line)) continue;
      this.#measure(line);
      remaining--;
    }
    if (this.#from >= this.#pending.length) {
      this.#pending = [];
      this.#from = 0;
    }
    return this.pending();
  }

  get #length(): number {
    return this.#sizeOf(this.#root);
  }

  #measureSpan(span: LineEdit): void {
    const from = Math.max(0, span.firstLine);
    const to = Math.min(this.#length, span.firstLine + Math.max(1, span.insertedLines));
    if (this.#columns === Infinity) {
      // One row whatever the text says: no line needs reading.
      for (let line = from; line < to; line++) {
        this.#rows.delete(line);
        this.#setCount(line, 1);
      }
      return;
    }
    if (to - from > measuredNow) {
      for (let line = from; line < to; line++) {
        this.#rows.delete(line);
        this.#markDirty(line);
      }
      this.#queueDirty();
      return;
    }
    for (let line = from; line < to; line++) {
      this.#rows.delete(line);
      this.#measure(line);
    }
  }

  /**
   * Applies the line-count change of one batch. Spans are post-edit coordinates, so each one's
   * old position drops the net change of the spans before it; walking them last to first keeps
   * the untouched lines before each span where they are.
   */
  #restructure(spans: readonly LineEdit[]): void {
    const sorted = [...spans].toSorted((a, b) => a.firstLine - b.firstLine);
    const changes: { at: number; removed: number; inserted: number }[] = [];
    let shift = 0;
    for (const span of sorted) {
      const inserted = Math.max(1, span.insertedLines);
      changes.push({ at: span.firstLine - shift, removed: span.removedLines, inserted });
      shift += inserted - span.removedLines;
    }
    for (let index = changes.length - 1; index >= 0; index--) {
      const change = changes[index];
      if (!change) continue;
      if (change.removed > 0) this.#erase(change.at, change.removed);
      if (change.inserted > 0) this.#insert(change.at, change.inserted);
    }
    this.#rows.clear();
    this.#pending = [];
    this.#from = 0;
    if (this.#columns === Infinity || this.#dirtyCount === 0) return;
    this.#walk((node) => {
      this.#queued[node] = 0;
    });
    this.#queueDirty();
  }

  #insert(at: number, count: number): void {
    const [before, after] = this.#split(this.#root, at);
    this.#root = this.#merge(this.#merge(before, this.#build(count)), after);
  }

  #erase(at: number, count: number): void {
    const [before, rest] = this.#split(this.#root, at);
    const [gone, after] = this.#split(rest, count);
    this.#root = this.#merge(before, after);
    this.#freeTree(gone);
  }

  /** A treap of `count` fresh one-row lines, for an insertion or the document it opens with. */
  #build(count: number): number {
    let root = 0;
    for (let index = 0; index < count; index++) root = this.#merge(root, this.#allocate());
    return root;
  }

  #allocate(): number {
    let node = this.#free.pop();
    if (node === undefined) {
      if (this.#used + 2 >= this.#left.length) this.#grow();
      node = ++this.#used;
    }
    this.#left[node] = 0;
    this.#right[node] = 0;
    this.#size[node] = 1;
    this.#count[node] = 1;
    this.#sum[node] = 1;
    this.#dirty[node] = 1;
    this.#queued[node] = 0;
    this.#priority[node] = priority(++this.#seed);
    this.#dirtyCount++;
    return node;
  }

  /** Doubles the node arrays; a treap over a large file runs out of ids in bursts. */
  #grow(): void {
    const size = this.#left.length * 2;
    const growInts = (array: Int32Array) => {
      const next = new Int32Array(size);
      next.set(array);
      return next;
    };
    this.#left = growInts(this.#left);
    this.#right = growInts(this.#right);
    this.#size = growInts(this.#size);
    this.#count = growInts(this.#count);
    this.#sum = growInts(this.#sum);
    const dirty = new Uint8Array(size);
    dirty.set(this.#dirty);
    this.#dirty = dirty;
    const queued = new Uint8Array(size);
    queued.set(this.#queued);
    this.#queued = queued;
    const priorities = new Uint32Array(size);
    priorities.set(this.#priority);
    this.#priority = priorities;
  }

  #split(node: number, count: number): [number, number] {
    if (node === 0) return [0, 0];
    const left = this.#leftOf(node);
    const leftSize = this.#sizeOf(left);
    if (count <= leftSize) {
      const [before, after] = this.#split(left, count);
      this.#left[node] = after;
      this.#pull(node);
      return [before, node];
    }
    const [before, after] = this.#split(this.#rightOf(node), count - leftSize - 1);
    this.#right[node] = before;
    this.#pull(node);
    return [node, after];
  }

  #merge(a: number, b: number): number {
    if (a === 0) return b;
    if (b === 0) return a;
    if (this.#priorityOf(a) > this.#priorityOf(b)) {
      this.#right[a] = this.#merge(this.#rightOf(a), b);
      this.#pull(a);
      return a;
    }
    this.#left[b] = this.#merge(a, this.#leftOf(b));
    this.#pull(b);
    return b;
  }

  /** Forgets a removed subtree and offers its nodes back for reuse. */
  #freeTree(root: number): void {
    if (root === 0) return;
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (node === undefined) continue;
      const left = this.#leftOf(node);
      const right = this.#rightOf(node);
      if (left) stack.push(left);
      if (right) stack.push(right);
      if (this.#dirty[node] === 1) this.#dirtyCount--;
      this.#dirty[node] = 0;
      this.#queued[node] = 0;
      this.#free.push(node);
    }
  }

  #pull(node: number): void {
    const left = this.#leftOf(node);
    const right = this.#rightOf(node);
    this.#size[node] = 1 + this.#sizeOf(left) + this.#sizeOf(right);
    this.#sum[node] = this.#countOf(node) + this.#sumOf(left) + this.#sumOf(right);
  }

  #isDirty(line: number): boolean {
    const node = this.#nodeAt(line);
    return node !== 0 && this.#dirty[node] === 1;
  }

  #measure(line: number): readonly WrapRow[] {
    const rows = wrapLine(this.#text.line(line), this.#columns);
    this.#setCount(line, rows.length);
    return rows;
  }

  /** Sets a line's row count, clears its estimate flag, and settles the sums above it. */
  #setCount(line: number, count: number): void {
    const path: number[] = [];
    let node = this.#root;
    let index = line;
    while (node) {
      path.push(node);
      const left = this.#leftOf(node);
      const leftSize = this.#sizeOf(left);
      if (index < leftSize) {
        node = left;
        continue;
      }
      if (index === leftSize) break;
      index -= leftSize + 1;
      node = this.#rightOf(node);
    }
    if (node === 0) return;
    if (this.#dirty[node] === 1) {
      this.#dirty[node] = 0;
      this.#dirtyCount--;
    }
    this.#queued[node] = 0;
    this.#count[node] = count;
    for (let at = path.length - 1; at >= 0; at--) {
      const current = path[at];
      if (current !== undefined) this.#pull(current);
    }
  }

  #markDirty(line: number): void {
    const node = this.#nodeAt(line);
    if (node === 0 || this.#dirty[node] === 1) return;
    this.#dirty[node] = 1;
    this.#dirtyCount++;
  }

  #nodeAt(line: number): number {
    let node = this.#root;
    let index = line;
    while (node) {
      const left = this.#leftOf(node);
      const leftSize = this.#sizeOf(left);
      if (index < leftSize) {
        node = left;
        continue;
      }
      if (index === leftSize) return node;
      index -= leftSize + 1;
      node = this.#rightOf(node);
    }
    return 0;
  }

  /** Queues every dirty line in document order; a line already queued is left where it is. */
  #queueDirty(): void {
    if (this.#dirtyCount === 0) return;
    let line = 0;
    this.#walk((node) => {
      if (this.#dirty[node] === 1 && this.#queued[node] !== 1) {
        this.#queued[node] = 1;
        this.#pending.push(line);
      }
      line++;
    });
  }

  #walk(visit: (node: number) => void): void {
    const stack: number[] = [];
    let node = this.#root;
    while (node || stack.length) {
      while (node) {
        stack.push(node);
        node = this.#leftOf(node);
      }
      const top = stack.pop();
      if (top === undefined) break;
      visit(top);
      node = this.#rightOf(top);
    }
  }

  #leftOf(node: number): number {
    return node === 0 ? 0 : (this.#left[node] ?? 0);
  }

  #rightOf(node: number): number {
    return node === 0 ? 0 : (this.#right[node] ?? 0);
  }

  #sizeOf(node: number): number {
    return node === 0 ? 0 : (this.#size[node] ?? 0);
  }

  #countOf(node: number): number {
    return node === 0 ? 0 : (this.#count[node] ?? 0);
  }

  #sumOf(node: number): number {
    return node === 0 ? 0 : (this.#sum[node] ?? 0);
  }

  #priorityOf(node: number): number {
    return node === 0 ? 0 : (this.#priority[node] ?? 0);
  }
}
