import type { LineEdit } from "@ace/editor";
import { hiddenRanges, type FoldRange } from "./folding.ts";

/*
 * The closed folds of one editor, kept through edits in work near the edit rather than work
 * over every fold (a file after Fold All holds one per block). Folds stay sorted by header line;
 * an edit's shift of everything below it is held as one pending offset that moves only as far
 * as the next edit is from the last, so typing in one place shifts nothing twice. The merged
 * hidden ranges ride along the same way, so finding the folds around an edit is a search, not a
 * scan. Same rules as `mapFolds`; pure.
 */

type Range = { from: number; to: number };

/**
 * Sorted pairs whose entries from `gap` on carry a pending `delta`: shifting everything from an
 * index costs the distance from the last shift, not the count after it.
 */
class ShiftedPairs {
  #a: number[] = [];
  #b: number[] = [];
  #gap = 0;
  #delta = 0;

  get length(): number {
    return this.#a.length;
  }
  a(index: number): number {
    return (this.#a[index] ?? 0) + (index >= this.#gap ? this.#delta : 0);
  }
  b(index: number): number {
    return (this.#b[index] ?? 0) + (index >= this.#gap ? this.#delta : 0);
  }
  /** The first index whose `a` is at least `value`. */
  lowerBound(value: number): number {
    let low = 0;
    let high = this.#a.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.a(middle) < value) low = middle + 1;
      else high = middle;
    }
    return low;
  }
  #moveGap(to: number): void {
    if (this.#gap >= this.#a.length) this.#delta = 0;
    if (this.#delta === 0) {
      this.#gap = to;
      return;
    }
    const delta = this.#delta;
    for (; this.#gap < to; this.#gap++) {
      this.#a[this.#gap] = (this.#a[this.#gap] ?? 0) + delta;
      this.#b[this.#gap] = (this.#b[this.#gap] ?? 0) + delta;
    }
    while (this.#gap > to) {
      this.#gap--;
      this.#a[this.#gap] = (this.#a[this.#gap] ?? 0) - delta;
      this.#b[this.#gap] = (this.#b[this.#gap] ?? 0) - delta;
    }
  }
  /** Adds `delta` to every entry from `index` on. */
  shiftFrom(index: number, delta: number): void {
    if (delta === 0 || index >= this.#a.length) return;
    this.#moveGap(index);
    this.#delta += delta;
  }
  /** Replaces `count` entries at `index` with `items`, given in true values. */
  splice(index: number, count: number, items: readonly (readonly [number, number])[]): void {
    this.#moveGap(index);
    const delta = this.#delta;
    const a = items.map(([value]) => value - delta);
    const b = items.map(([, value]) => value - delta);
    // Spreading a long list into splice overflows the stack: a whole replacement is a new list.
    if (index === 0 && count >= this.#a.length) {
      this.#a = a;
      this.#b = b;
      this.#gap = 0;
      return;
    }
    this.#a.splice(index, count, ...a);
    this.#b.splice(index, count, ...b);
  }
}

/** `ranges` minus `cut`, both sorted and disjoint. */
function subtract(ranges: readonly Range[], cut: readonly Range[]): Range[] {
  const out: Range[] = [];
  for (const range of ranges) {
    let from = range.from;
    for (const piece of cut) {
      if (piece.to <= from || piece.from >= range.to) continue;
      if (piece.from > from) out.push({ from, to: piece.from });
      from = Math.max(from, piece.to);
    }
    if (from < range.to) out.push({ from, to: range.to });
  }
  return out;
}

/** Lines through one span (post-edit coordinates): the replaced lines become the new ones. */
function mapRange(range: Range, from: number, to: number, inserted: number): Range[] {
  const delta = inserted - (to - from);
  const out: Range[] = [];
  if (range.from < from) out.push({ from: range.from, to: Math.min(range.to, from) });
  if (range.from < to && range.to > from) out.push({ from, to: from + inserted });
  if (range.to > to) out.push({ from: Math.max(range.from, to) + delta, to: range.to + delta });
  return out;
}

export class FoldSet {
  readonly #folds = new ShiftedPairs();
  /** The folds' hidden lines, merged as `hiddenRanges` merges them. */
  readonly #hidden = new ShiftedPairs();

  static of(folds: readonly FoldRange[]): FoldSet {
    const set = new FoldSet();
    set.replace(folds);
    return set;
  }

  get size(): number {
    return this.#folds.length;
  }

  /** Whether a closed fold starts on `line`. */
  has(line: number): boolean {
    const at = this.#folds.lowerBound(line);
    return at < this.#folds.length && this.#folds.a(at) === line;
  }

  toArray(): FoldRange[] {
    const out: FoldRange[] = [];
    for (let index = 0; index < this.#folds.length; index++)
      out.push({ start: this.#folds.a(index), end: this.#folds.b(index) });
    return out;
  }

  /** Every fold at once, as a command (fold all, unfold) sets them. */
  replace(folds: readonly FoldRange[]): void {
    const sorted = folds.toSorted((a, b) => a.start - b.start);
    this.#folds.splice(
      0,
      this.#folds.length,
      sorted.map((fold) => [fold.start, fold.end] as const),
    );
    this.#hidden.splice(
      0,
      this.#hidden.length,
      hiddenRanges(sorted).map((range) => [range.from, range.to] as const),
    );
  }

  /**
   * Carries the folds through an applied edit: folds below move, a fold whose hidden text or
   * header line count changed opens. Returns the lines that opening showed, `[from, to)` in
   * the new text, for the row index to draw again.
   */
  map(spans: readonly LineEdit[]): Range[] {
    let shown: Range[] = [];
    for (const span of spans.toSorted((a, b) => a.firstLine - b.firstLine)) {
      const from = span.firstLine;
      const to = from + Math.max(1, span.removedLines);
      shown = shown.flatMap((range) => mapRange(range, from, to, span.insertedLines));
      shown.push(...this.#mapSpan(from, to, span.insertedLines));
    }
    return shown.toSorted((a, b) => a.from - b.from);
  }

  #mapSpan(from: number, to: number, inserted: number): Range[] {
    const folds = this.#folds;
    const hidden = this.#hidden;
    const delta = inserted - (to - from);
    // The merged hidden range around `from`, if any: the folds that contain the edit are in it.
    const around = hidden.lowerBound(from + 1) - 1;
    const inside = around >= 0 && hidden.b(around) > from;
    const lo = folds.lowerBound(from);
    const hi = folds.lowerBound(to);
    const first = inside ? folds.lowerBound(hidden.a(around) - 1) : lo;
    const keeps = (index: number) => {
      const start = folds.a(index);
      if (start < from) return folds.b(index) < from;
      return delta === 0 && start === from && to === from + 1;
    };
    let opens = false;
    for (let index = first; index < hi && !opens; index++) opens = !keeps(index);
    if (!opens) {
      folds.shiftFrom(hi, delta);
      hidden.shiftFrom(hidden.lowerBound(to), delta);
      return [];
    }
    // Rebuild the merged ranges the opened folds were in, from the folds left in them.
    const hiddenFirst = inside ? around : hidden.lowerBound(from + 1);
    const hiddenEnd = hidden.lowerBound(to + 1);
    const before: Range[] = [];
    for (let index = hiddenFirst; index < hiddenEnd; index++)
      before.push({ from: hidden.a(index), to: hidden.b(index) });
    const end = Math.max(hi, before.length ? folds.lowerBound(before.at(-1)?.to ?? 0) : hi);
    const left: FoldRange[] = [];
    for (let index = first; index < end; index++) {
      if (index < hi && !keeps(index)) continue;
      const shift = index >= hi ? delta : 0;
      left.push({ start: folds.a(index) + shift, end: folds.b(index) + shift });
    }
    folds.splice(
      first,
      end - first,
      left.map((fold) => [fold.start, fold.end] as const),
    );
    folds.shiftFrom(first + left.length, delta);
    const after = hiddenRanges(left);
    hidden.splice(
      hiddenFirst,
      hiddenEnd - hiddenFirst,
      after.map((range) => [range.from, range.to] as const),
    );
    hidden.shiftFrom(hiddenFirst + after.length, delta);
    const moved = before.flatMap((range) => mapRange(range, from, to, inserted));
    return subtract(moved, after);
  }
}
