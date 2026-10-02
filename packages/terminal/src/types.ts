export interface OpenTerminalOptions {
  cwd: string;
  shell?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  cols: number;
  rows: number;
  name: string;
}

export interface ExitStatus {
  code: number;
  /** POSIX signal number, or null for a normal exit. */
  signal: number | null;
}

export type TerminalEvent =
  | {
      type: "data";
      offset: number;
      endOffset: number;
      data: string;
      truncatedBefore: boolean;
    }
  | { type: "resync"; oldestOffset: number; nextOffset: number }
  | { type: "exit"; status: ExitStatus; nextOffset: number };

export interface TerminalAttachment extends AsyncIterableIterator<TerminalEvent> {
  detach(): void;
}

export interface TerminalSnapshot {
  version: 1;
  name: string;
  cwd: string;
  shell: string;
  pid: number;
  cols: number;
  rows: number;
  capacity: number;
  oldestOffset: number;
  nextOffset: number;
  /** Raw retained bytes, including any incomplete UTF-8 suffix. */
  data: string;
  exit: ExitStatus | null;
}

export function validateDimensions(cols: number, rows: number): void {
  if (
    !Number.isSafeInteger(cols) ||
    !Number.isSafeInteger(rows) ||
    cols < 1 ||
    rows < 1 ||
    cols > 65535 ||
    rows > 65535
  ) {
    throw new RangeError("Terminal dimensions must be integers from 1 through 65535");
  }
}
