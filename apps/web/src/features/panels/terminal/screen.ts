/**
 * A line-oriented terminal screen: enough of VT100 for shells, test runners, build tools and
 * progress bars (CR overwrite, backspace, erase, cursor moves, SGR colour), not for
 * full-screen programs. Pure: feed it text, read rows. Escape sequences split across chunks
 * are held until complete.
 */
export type Tone = "red" | "green" | "yellow" | "blue" | "magenta" | "cyan";
export interface Style {
  bold?: true;
  dim?: true;
  tone?: Tone;
}
export interface Segment {
  text: string;
  style: Style;
}
export interface Row {
  /** Stable while the row exists, for React keys. */
  id: number;
  segments: Segment[];
}

interface Cell {
  char: string;
  style: Style;
}

const tones: Record<number, Tone> = {
  1: "red",
  2: "green",
  3: "yellow",
  4: "blue",
  5: "magenta",
  6: "cyan",
};
const plain: Style = {};
// CSI: ESC [ params final; OSC: ESC ] ... (BEL | ESC \); other two-byte escapes.
// oxlint-disable-next-line no-control-regex
const csi = /^\x1b\[([0-9;?]*)([@-~])/;
// oxlint-disable-next-line no-control-regex
const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/;

export class TerminalScreen {
  private lines: Cell[][] = [[]];
  private ids: number[] = [0];
  private nextId = 1;
  private row = 0;
  private col = 0;
  private style: Style = plain;
  private pending = "";
  private cache: Row[] | undefined;
  /** Rows built for the last `rows()`, by id; a row written since is dropped from here. */
  private built = new Map<number, Row>();
  private lastWritten = -1;
  private limit: number;
  constructor(options: { scrollback?: number } = {}) {
    this.limit = options.scrollback ?? 5000;
  }
  write(text: string): void {
    let input = this.pending + text;
    this.pending = "";
    while (input.length) {
      const escape = input.indexOf("\x1b");
      const chunk = escape === -1 ? input : input.slice(0, escape);
      for (const char of chunk) this.char(char);
      if (escape === -1) break;
      input = input.slice(escape);
      const consumed = this.escape(input);
      if (consumed === 0) {
        // Incomplete sequence: keep it for the next chunk (bounded, so junk can't grow it).
        this.pending = input.length < 64 ? input : "";
        break;
      }
      input = input.slice(consumed);
    }
    this.cache = undefined;
    this.trim();
  }
  /** Erase everything, like ⌘K in a desktop terminal. */
  clear(): void {
    this.lines = [[]];
    this.ids = [this.nextId++];
    this.row = 0;
    this.col = 0;
    this.cache = undefined;
  }
  /**
   * The rows, a new array after each write. Rows that did not change keep their object, so a
   * redraw re-renders only the rows output touched.
   */
  rows(): readonly Row[] {
    if (this.cache) return this.cache;
    const built = this.built;
    const rows = this.lines.map((cells, index) => {
      const id = this.ids[index] ?? index;
      return built.get(id) ?? { id, segments: segment(cells) };
    });
    this.built = new Map(rows.map((row) => [row.id, row]));
    this.lastWritten = -1;
    this.cache = rows;
    return rows;
  }
  /** Plain text, rows joined by newlines; trailing empty rows dropped. */
  text(): string {
    return this.lines
      .map((cells) => cells.map((cell) => cell.char).join(""))
      .join("\n")
      .replace(/\n+$/, "");
  }
  private char(char: string): void {
    switch (char) {
      case "\r":
        this.col = 0;
        return;
      case "\n":
        this.row++;
        this.ensureRow();
        return;
      case "\b":
        this.col = Math.max(0, this.col - 1);
        return;
      case "\t":
        this.col = (Math.floor(this.col / 8) + 1) * 8;
        this.pad();
        return;
      case "\x07":
        return;
    }
    if (char < " ") return;
    const line = this.line();
    this.pad();
    line[this.col] = { char, style: this.style };
    this.col++;
  }
  /** Returns how many characters the escape at the start of `input` used; 0 if incomplete. */
  private escape(input: string): number {
    if (input.length < 2) return 0;
    if (input[1] === "[") {
      const match = csi.exec(input);
      // oxlint-disable-next-line no-control-regex
      if (!match) return /^\x1b\[[0-9;?]*$/.test(input) ? 0 : 2;
      this.control(match[1] ?? "", match[2] ?? "");
      return match[0].length;
    }
    if (input[1] === "]") {
      const match = osc.exec(input);
      return match ? match[0].length : 0;
    }
    return 2;
  }
  private control(params: string, final: string): void {
    const numbers = params
      .replace("?", "")
      .split(";")
      .map((part) => (part === "" ? undefined : Number(part)));
    const n = numbers[0] ?? 1;
    switch (final) {
      case "m":
        this.sgr(numbers.length ? numbers : [0]);
        return;
      case "J":
        if ((numbers[0] ?? 0) >= 2) this.clear();
        else if ((numbers[0] ?? 0) === 0) {
          this.line().length = Math.min(this.line().length, this.col);
          this.lines.length = this.row + 1;
          this.ids.length = this.row + 1;
        }
        return;
      case "K": {
        const mode = numbers[0] ?? 0;
        const line = this.line();
        if (mode === 0) line.length = Math.min(line.length, this.col);
        else if (mode === 1) for (let i = 0; i < this.col && i < line.length; i++) line[i] = space;
        else line.length = 0;
        return;
      }
      case "H":
      case "f":
        // Positions are relative to the visible screen; without a fixed height the best
        // reading is "the top of what was last cleared", which is where shells put it.
        this.row = Math.max(0, (numbers[0] ?? 1) - 1);
        this.col = Math.max(0, (numbers[1] ?? 1) - 1);
        this.ensureRow();
        return;
      case "A":
        this.row = Math.max(0, this.row - n);
        return;
      case "B":
        this.row += n;
        this.ensureRow();
        return;
      case "C":
        this.col += n;
        return;
      case "D":
        this.col = Math.max(0, this.col - n);
        return;
      case "G":
        this.col = Math.max(0, n - 1);
        return;
    }
  }
  private sgr(codes: readonly (number | undefined)[]): void {
    let style: Style = { ...this.style };
    for (const code of codes) {
      if (code === undefined || code === 0) style = {};
      else if (code === 1) style.bold = true;
      else if (code === 2) style.dim = true;
      else if (code === 22) {
        delete style.bold;
        delete style.dim;
      } else if (code === 39) delete style.tone;
      else if ((code >= 31 && code <= 36) || (code >= 91 && code <= 96)) {
        const tone = tones[code % 10];
        if (tone) style.tone = tone;
      }
    }
    this.style = Object.keys(style).length ? style : plain;
  }
  /** The cursor's line, for writing: its built row is stale from here on. */
  private line(): Cell[] {
    this.ensureRow();
    const line = this.lines[this.row];
    if (!line) throw new Error("unreachable: row ensured");
    const id = this.ids[this.row] ?? this.row;
    if (id !== this.lastWritten) {
      this.built.delete(id);
      this.lastWritten = id;
    }
    return line;
  }
  private ensureRow(): void {
    while (this.lines.length <= this.row) {
      this.lines.push([]);
      this.ids.push(this.nextId++);
    }
  }
  private pad(): void {
    const line = this.line();
    while (line.length < this.col) line.push(space);
  }
  private trim(): void {
    const excess = this.lines.length - this.limit;
    if (excess <= 0) return;
    this.lines.splice(0, excess);
    this.ids.splice(0, excess);
    this.row = Math.max(0, this.row - excess);
  }
}

const space: Cell = { char: " ", style: plain };

function same(a: Style, b: Style): boolean {
  return a === b || (a.bold === b.bold && a.dim === b.dim && a.tone === b.tone);
}

function segment(cells: readonly Cell[]): Segment[] {
  const segments: Segment[] = [];
  for (const cell of cells) {
    const last = segments.at(-1);
    if (last && same(last.style, cell.style)) last.text += cell.char;
    else segments.push({ text: cell.char, style: cell.style });
  }
  return segments;
}
