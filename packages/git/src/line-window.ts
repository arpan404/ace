import type { RevisionLines } from "./types.ts";

/** Retain one bounded line window while consuming arbitrary chunks of immutable file text. */
export class LineWindow {
  private readonly start: number;
  private readonly end: number;
  private readonly maxChars: number;
  private number = 1;
  private fragment = "";
  private readonly lines: string[] = [];
  private chars = 0;
  private overflow = false;
  private seen = false;
  private terminated = false;
  constructor(start: number, end: number, maxChars: number) {
    this.start = start;
    this.end = end;
    this.maxChars = maxChars;
  }
  append(text: string): void {
    if (!text) return;
    this.seen = true;
    this.terminated = text.endsWith("\n");
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      const last = newline < 0 ? text.length : newline;
      if (this.number >= this.start && this.number <= this.end) {
        const count = last - offset;
        this.chars += count;
        if (this.chars > this.maxChars) this.overflow = true;
        if (!this.overflow) this.fragment += text.slice(offset, last);
        if (newline >= 0) {
          if (!this.overflow) this.lines.push(this.fragment);
          this.fragment = "";
        }
      }
      if (newline < 0) break;
      this.number++;
      offset = newline + 1;
    }
  }
  finish(): RevisionLines | undefined {
    if (this.overflow) return undefined;
    if (this.seen && !this.terminated) {
      if (this.number >= this.start && this.number <= this.end) this.lines.push(this.fragment);
      this.number++;
    }
    return {
      lines: this.lines,
      atEof: this.number - 1 <= this.end,
      noFinalNewline: this.seen && !this.terminated,
    };
  }
}
