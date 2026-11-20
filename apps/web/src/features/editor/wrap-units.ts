import { clusterWidth, clusters, isAscii, tabSize, type Cluster } from "./geometry.ts";

/*
 * The units a line is wrapped by, read one at a time: a code unit of an ASCII line, or one
 * grapheme cluster. A row break can fall before units already read, because the whitespace run it
 * breaks at is earlier than the unit that did not fit, so the reader can rewind to a mark taken
 * while reading the row.
 *
 * An ASCII line reads code units in place, with no segmentation and no per-character object. Any
 * other line is read in chunks: an ASCII chunk still reads code units, a chunk with other text
 * segments only that chunk, and the units of the row being read are kept until its break is known.
 * A line is therefore never held as one object per character, however long it is.
 */

/** One unit a line is wrapped by. */
export interface Unit {
  start: number;
  end: number;
  /** Cells it takes, except a tab, whose cells depend on where it starts. */
  width: number;
  tab: boolean;
  /** A space or a tab: a place a row may break. */
  space: boolean;
}

/** The cells a unit takes from `cells` into its row, with a tab expanding to the next stop. */
export function cellOf(unit: Unit, cells: number): number {
  return unit.tab ? tabSize - (cells % tabSize) : unit.width;
}

function codeUnit(text: string, at: number): Unit {
  const code = text.charCodeAt(at);
  const tab = code === 9;
  return { start: at, end: at + 1, width: tab ? 0 : 1, tab, space: tab || code === 32 };
}

function clusterUnit(cluster: Cluster, base: number): Unit {
  const tab = cluster.text === "\t";
  const start = base + cluster.start;
  return {
    start,
    end: start + cluster.text.length,
    width: tab ? 0 : clusterWidth(cluster.text),
    tab,
    space: tab || cluster.text === " ",
  };
}

/** Code units read and segmented in one go: a line is never segmented in one piece. */
const unitChunk = 4_096;

export class UnitReader {
  readonly #text: string;
  readonly #ascii: boolean;
  #at = 0;
  /** Where the next chunk starts, in the chunked path. */
  #generated = 0;
  #buffered: Unit[] = [];
  #from = 0;
  readonly #unit: Unit = { start: 0, end: 0, width: 0, tab: false, space: false };

  constructor(text: string) {
    this.#text = text;
    this.#ascii = isAscii(text);
  }

  /** The next unit, or undefined at the line's end. The object may be reused by the next call. */
  peek(): Unit | undefined {
    if (this.#ascii) {
      if (this.#at >= this.#text.length) return undefined;
      const code = this.#text.charCodeAt(this.#at);
      this.#unit.start = this.#at;
      this.#unit.end = this.#at + 1;
      this.#unit.tab = code === 9;
      this.#unit.space = code === 9 || code === 32;
      this.#unit.width = this.#unit.tab ? 0 : 1;
      return this.#unit;
    }
    while (this.#from >= this.#buffered.length) {
      if (this.#generated >= this.#text.length) return undefined;
      this.#fill();
    }
    return this.#buffered[this.#from];
  }

  /** Moves past the unit the last {@link peek} returned. */
  take(): void {
    if (this.#ascii) this.#at = this.#unit.end;
    else this.#from++;
  }

  /** A position the reader can come back to while reading the same row. */
  mark(): number {
    return this.#ascii ? this.#at : this.#from;
  }

  rewind(mark: number): void {
    if (this.#ascii) this.#at = mark;
    else this.#from = mark;
  }

  /** Forgets the units a finished row consumed; no row looks back past its own start. */
  drop(): void {
    if (this.#ascii || this.#from < 64) return;
    this.#buffered = this.#buffered.slice(this.#from);
    this.#from = 0;
  }

  /** Reads the next chunk of units: code units where it is ASCII, whole clusters elsewhere. */
  #fill(): void {
    const text = this.#text;
    const at = this.#generated;
    const limit = Math.min(text.length, at + unitChunk);
    if (isAscii(text.slice(at, limit))) {
      for (let index = at; index < limit; index++) this.#buffered.push(codeUnit(text, index));
      this.#generated = limit;
      return;
    }
    let window = Math.min(text.length, limit + 64);
    for (;;) {
      for (const cluster of clusters(text.slice(at, window))) {
        const end = at + cluster.start + cluster.text.length;
        // A cluster the window cut short, or one past this chunk, is read with the next chunk.
        if (end >= window && window < text.length) break;
        if (end > limit) break;
        this.#buffered.push(clusterUnit(cluster, at));
        this.#generated = end;
      }
      if (this.#generated > at) return;
      // One cluster longer than the whole window: widen until it ends, or the line does.
      if (window >= text.length) {
        const first = clusters(text.slice(at)).next();
        if (first.done) {
          this.#generated = text.length;
          return;
        }
        this.#buffered.push(clusterUnit(first.value, at));
        this.#generated = at + first.value.text.length;
        return;
      }
      window = Math.min(text.length, window * 2);
    }
  }
}
