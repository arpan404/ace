import { UnifiedDiffLines, type DiffRow } from "./diff.ts";

/*
 * One file's section of a `git diff` patch read in parts, as pages of it arrive: each part is
 * parsed once, the line it ends inside is held until the next part finishes it, and the rows
 * add up to what `gitPatchFiles` makes of the whole section. Pure; work per part is
 * proportional to the part.
 */
export class PatchFileReader {
  /** The section's rows so far; earlier rows never change as more parts arrive. */
  readonly rows: DiffRow[] = [];
  #lines = new UnifiedDiffLines();
  /** The part of a line the last part ended inside. */
  #partial = "";
  #sections = 0;
  #ended = false;

  /** Read the next part of the section. */
  push(text: string): void {
    if (this.#ended || text === "") return;
    let start = 0;
    for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
      const line = this.#partial ? this.#partial + text.slice(start, end) : text.slice(start, end);
      this.#partial = "";
      this.#line(line);
      start = end + 1;
      if (this.#ended) return;
    }
    this.#partial += text.slice(start);
  }

  /** No more parts come: the line the last one ended inside is read as it is. */
  end(): void {
    if (!this.#ended && this.#partial !== "") this.#line(this.#partial);
    this.#partial = "";
    this.#ended = true;
  }

  #line(line: string): void {
    // A second section (another path of the read) isn't this file's.
    if (this.#lines.between && line.startsWith("diff --git ") && ++this.#sections > 1) {
      this.#ended = true;
      return;
    }
    this.#lines.read(line, this.rows);
  }
}
