/*
 * The visual rows of the whole open document: a row count for every line in an implicit treap,
 * so a line's start row, the line a row belongs to, and an edit that inserts or removes lines
 * all cost logarithmic time instead of a walk over the file.
 *
 * Measured rows and queued work belong to the treap node a line lives in, not to its line
 * number: an edit that inserts or removes lines moves the numbers but keeps the identities, so
 * nothing measured or pending is thrown away. A width change re-measures the lines on screen at
 * once and spreads the rest over slices, a line's text change re-measures only the lines its
 * span covers, and the counts keep their old values as estimates until then, so the scroll
 * height never collapses in between.
 *
 * No line is measured while the document's version differs from the one the tree holds: a row
 * count is only ever computed from the text it describes, never from a document that has already
 * moved on underneath an older tree.
 */

import type { LineEdit } from "@ace/editor";
import { wholeLineRow, wrapLine, type WrapRow } from "./wrap.ts";

/** The text the index wraps: the open document, asked one line at a time. */
export interface WrapText {
  lenLines(): number;
  line(index: number): string;
  /** The document's version, so the tree never measures text from another one. */
  version(): number;
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

/** The spans of one applied edit, and the document's line count and version after it. */
export interface LineBatch {
  spans: readonly LineEdit[];
  lines: number;
  /** The document's version once the spans were applied. */
  version: number;
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
  /** The document version every count in the tree was measured from. */
  #version: number;
  /** Measured rows by node, so a line keeps its rows while the lines around it move. */
  #rows = new Map<number, readonly WrapRow[]>();
  /** Nodes still to measure at this width, in the order they were queued. */
  #pending: number[] = [];
  #from = 0;
  #dirtyCount = 0;

  // The implicit treap, 1-based: node 0 is the empty tree. Its in-order walk is the document.
  #left = new Int32Array(64);
  #right = new Int32Array(64);
  /** Each node's parent, so a node's rank and the sums above it need no walk from the root. */
  #parent = new Int32Array(64);
  /** Nodes in this subtree, this one included. */
  #size = new Int32Array(64);
  /** This line's rows. */
  #count = new Int32Array(64);
  /** Rows in this subtree, this one included. */
  #sum = new Int32Array(64);
  /** 1 = the count is an estimate to re-measure at this width. */
  #dirty = new Uint8Array(64);
  /** The node's generation when it was queued; 0 = not queued. */
  #queued = new Int32Array(64);
  /** A new generation each time a node is freed or handed out, which retires stale work. */
  #stamp = new Int32Array(64);
  #priority = new Uint32Array(64);
  #root = 0;
  #used = 0;
  #seed = 0;
  #free: number[] = [];

  constructor(text: WrapText) {
    this.#text = text;
    this.#version = text.version();
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
        this.#queued[node] = 0;
        this.#sum[node] = this.#sizeOf(node);
      });
      this.#dirtyCount = 0;
      return true;
    }
    this.#walk((node) => {
      this.#dirty[node] = 1;
      this.#queued[node] = 0;
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
    for (let line = from; line < to; line++) {
      const node = this.#nodeAt(line);
      if (node === 0 || this.#dirty[node] !== 1) continue;
      this.#measure(node);
    }
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
    const node = this.#nodeAt(line);
    if (node === 0) return wholeLineRow;
    const known = this.#rows.get(node);
    if (known) return known;
    const rows = this.#measure(node);
    if (!rows) return wholeLineRow;
    this.#remember(node, rows);
    return rows;
  }

  /**
   * Edits, one batch per applied edit, each in its own coordinate system. A batch whose spans
   * add or remove lines restructures the tree; every batch re-measures the lines it inserted,
   * or queues a span as long as the file for the background pass.
   */
  apply(batches: readonly LineBatch[]): void {
    for (const batch of batches) {
      this.#version = batch.version;
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
      const node = this.#pending[this.#from++];
      if (node === undefined) continue;
      // A freed node's id is reused with a new generation: work queued for the old one is gone.
      if (this.#queued[node] !== this.#stamp[node] || this.#dirty[node] !== 1) continue;
      if (!this.#measure(node)) break;
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
    // Every line is one row already, whatever its text: nothing to read or re-measure.
    if (this.#columns === Infinity) return;
    const from = Math.max(0, span.firstLine);
    const to = Math.min(this.#length, span.firstLine + Math.max(1, span.insertedLines));
    if (to - from > measuredNow) {
      for (let line = from; line < to; line++) this.#invalidate(this.#nodeAt(line));
      return;
    }
    for (let line = from; line < to; line++) {
      const node = this.#nodeAt(line);
      if (node === 0) continue;
      this.#invalidate(node);
      this.#measure(node);
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
  }

  #insert(at: number, count: number): void {
    const [before, after] = this.#split(this.#root, at);
    this.#root = this.#merge(this.#merge(before, this.#build(count)), after);
    this.#parent[this.#root] = 0;
  }

  #erase(at: number, count: number): void {
    const [before, rest] = this.#split(this.#root, at);
    const [gone, after] = this.#split(rest, count);
    this.#root = this.#merge(before, after);
    this.#parent[this.#root] = 0;
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
    // A new identity: anything queued or remembered for the previous occupant is stale.
    this.#stamp[node] = (this.#stamp[node] ?? 0) + 1;
    this.#left[node] = 0;
    this.#right[node] = 0;
    this.#parent[node] = 0;
    this.#size[node] = 1;
    this.#count[node] = 1;
    this.#sum[node] = 1;
    this.#queued[node] = 0;
    this.#priority[node] = priority(++this.#seed);
    this.#rows.delete(node);
    if (this.#columns === Infinity) {
      this.#dirty[node] = 0;
    } else {
      this.#dirty[node] = 1;
      this.#dirtyCount++;
    }
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
    this.#parent = growInts(this.#parent);
    this.#size = growInts(this.#size);
    this.#count = growInts(this.#count);
    this.#sum = growInts(this.#sum);
    this.#queued = growInts(this.#queued);
    this.#stamp = growInts(this.#stamp);
    const dirty = new Uint8Array(size);
    dirty.set(this.#dirty);
    this.#dirty = dirty;
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
      this.#parent[node] = 0;
      return [before, node];
    }
    const [before, after] = this.#split(this.#rightOf(node), count - leftSize - 1);
    this.#right[node] = before;
    this.#pull(node);
    this.#parent[node] = 0;
    return [node, after];
  }

  #merge(a: number, b: number): number {
    if (a === 0) return b;
    if (b === 0) return a;
    if (this.#priorityOf(a) > this.#priorityOf(b)) {
      this.#right[a] = this.#merge(this.#rightOf(a), b);
      this.#pull(a);
      this.#parent[a] = 0;
      return a;
    }
    this.#left[b] = this.#merge(a, this.#leftOf(b));
    this.#pull(b);
    this.#parent[b] = 0;
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
      this.#stamp[node] = (this.#stamp[node] ?? 0) + 1;
      this.#rows.delete(node);
      this.#free.push(node);
    }
  }

  /** Recomputes a node's counts from its children and points them back at it. */
  #pull(node: number): void {
    const left = this.#leftOf(node);
    const right = this.#rightOf(node);
    this.#size[node] = 1 + this.#sizeOf(left) + this.#sizeOf(right);
    this.#sum[node] = this.#countOf(node) + this.#sumOf(left) + this.#sumOf(right);
    if (left !== 0) this.#parent[left] = node;
    if (right !== 0) this.#parent[right] = node;
  }

  /** Recomputes the sums from a node up to the root, whose row total changed. */
  #settle(node: number): void {
    for (let current = node; current !== 0; current = this.#parentOf(current)) this.#pull(current);
  }

  /** The number of lines before `node`, read up its parent chain. */
  #rankOf(node: number): number {
    let rank = this.#sizeOf(this.#leftOf(node));
    let child = node;
    for (let parent = this.#parentOf(child); parent !== 0; parent = this.#parentOf(child)) {
      if (this.#rightOf(parent) === child) rank += this.#sizeOf(this.#leftOf(parent)) + 1;
      child = parent;
    }
    return rank;
  }

  /**
   * Measures one node's line at this width, answering its rows. Nothing is measured while the
   * document's version has moved past the tree's: the count would describe the wrong text.
   */
  #measure(node: number): readonly WrapRow[] | undefined {
    if (this.#text.version() !== this.#version) return undefined;
    const rows = wrapLine(this.#text.line(this.#rankOf(node)), this.#columns);
    this.#count[node] = rows.length;
    if (this.#dirty[node] === 1) {
      this.#dirty[node] = 0;
      this.#dirtyCount--;
    }
    this.#queued[node] = 0;
    this.#settle(node);
    return rows;
  }

  #remember(node: number, rows: readonly WrapRow[]): void {
    if (this.#rows.size >= cachedRows) this.#rows.clear();
    this.#rows.set(node, rows);
  }

  /** Drops a node's measured rows and queues it to be measured again at this width. */
  #invalidate(node: number): void {
    if (node === 0) return;
    this.#rows.delete(node);
    if (this.#dirty[node] !== 1) {
      this.#dirty[node] = 1;
      this.#dirtyCount++;
    }
    this.#enqueue(node);
  }

  /** Queues a node unless it is already queued under its current generation. */
  #enqueue(node: number): void {
    if (node === 0 || this.#queued[node] === this.#stamp[node]) return;
    this.#queued[node] = this.#stamp[node] ?? 0;
    this.#pending.push(node);
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
    this.#walk((node) => {
      if (this.#dirty[node] === 1) this.#enqueue(node);
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

  #parentOf(node: number): number {
    return node === 0 ? 0 : (this.#parent[node] ?? 0);
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
