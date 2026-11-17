import { describe, expect, it } from "vitest";
import { drawFrame, emptyDrawn } from "./frame.ts";

/** A tiny terminal that applies the sequences drawFrame writes, to check what ends up shown. */
function screen() {
  const rows: string[] = [""];
  let row = 0;
  let column = 0;
  return {
    rows,
    apply(output: string) {
      const pattern = /\x1b\[(\??)(\d*)([A-Za-z])|\r|\n|[^\x1b\r\n]+/g;
      for (const match of output.matchAll(pattern)) {
        const token = match[0];
        if (token === "\r") column = 0;
        else if (token === "\n") {
          row++;
          if (rows.length <= row) rows.push("");
        } else if (token.startsWith("\x1b")) {
          if (match[1] === "?") continue;
          const count = Number(match[2] || "1");
          const final = match[3];
          if (final === "A") row = Math.max(0, row - count);
          if (final === "B") row = Math.min(rows.length - 1, row + count);
          if (final === "C") column += count;
          if (final === "K") rows[row] = "";
          if (final === "J") rows.splice(row + 1), (rows[row] = rows[row]?.slice(0, column) ?? "");
        } else {
          const line = rows[row] ?? "";
          rows[row] = line.slice(0, column).padEnd(column) + token + line.slice(column + token.length);
          column += token.length;
        }
      }
    },
  };
}

describe("drawing the inline region", () => {
  it("draws the first frame below the prompt and redraws only changed lines", () => {
    const terminal = screen();
    const first = drawFrame(emptyDrawn, { lines: ["one", "two", "three"] });
    terminal.apply(first.output);
    expect(terminal.rows).toEqual(["one", "two", "three"]);
    const second = drawFrame(first.drawn, { lines: ["one", "TWO", "three"] });
    expect(second.output).not.toContain("one");
    expect(second.output).not.toContain("three");
    terminal.apply(second.output);
    expect(terminal.rows).toEqual(["one", "TWO", "three"]);
  });

  it("clears the lines a shorter frame gave up", () => {
    const terminal = screen();
    const first = drawFrame(emptyDrawn, { lines: ["a", "b", "c", "d"] });
    terminal.apply(first.output);
    const second = drawFrame(first.drawn, { lines: ["a", "x"] });
    terminal.apply(second.output);
    // The rows below stay on the terminal, empty.
    expect(terminal.rows.filter(Boolean)).toEqual(["a", "x"]);
    expect(second.drawn.lines).toEqual(["a", "x"]);
  });

  it("grows the region and leaves the cursor where the composer wants it", () => {
    const terminal = screen();
    const first = drawFrame(emptyDrawn, { lines: ["a"] });
    terminal.apply(first.output);
    const second = drawFrame(first.drawn, { lines: ["a", "b", "› hi"], cursor: { row: 2, column: 4 } });
    terminal.apply(second.output);
    expect(terminal.rows).toEqual(["a", "b", "› hi"]);
    expect(second.drawn.cursorRow).toBe(2);
    const third = drawFrame(second.drawn, { lines: ["a", "c", "› hi"] });
    terminal.apply(third.output);
    expect(terminal.rows).toEqual(["a", "c", "› hi"]);
  });
});
