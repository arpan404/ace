/*
 * What a terminal view (xterm, or the DOM screen where WebGL is missing) offers the tab around
 * it: focus, the scrollback for Find, revealing a match, and clipboard actions. The tab owns
 * the Find bar, the context menu and the toolbar; the view owns the pixels.
 */

export interface SurfaceText {
  /** The scrollback as a reader sees it: wrapped rows joined into lines. */
  lines: string[];
  /** For each line, the row it starts at. */
  starts: number[];
  /** Row width in cells, to map an offset in a wrapped line back to a row. */
  columns: number;
}

export interface TerminalSurface {
  focus(): void;
  text(): SurfaceText;
  /** Select `length` cells at `row`/`column` and scroll them into view. */
  reveal(row: number, column: number, length: number): void;
  /** Drop a revealed match's selection. */
  unmark(): void;
  /** The selected text, if any. */
  selection(): string;
  selectAll(): void;
  /** Type text into the shell as a paste (bracketed when the program asked for it). */
  paste(text: string): void;
}

/** 13px monospace on 20px rows with a 12px inset (the design's terminal text). */
export const terminalText = { size: 13, row: 20, inset: 12 } as const;

/**
 * Scrollback kept per terminal on screen. The page also keeps about a megabyte of raw output
 * per terminal (`raw-log.ts`) to redraw a view that mounts late; the daemon's ring holds what
 * reconnects replay.
 */
export const scrollbackRows = 10_000;
