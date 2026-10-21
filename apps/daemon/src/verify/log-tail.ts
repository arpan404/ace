import { maxCheckLogLength, type ForgeCheckLog } from "@ace/protocol";

/** A run's output as kept: the newest `limit` characters, cut at a line start. */
export interface LogTail {
  text: string;
  truncated: boolean;
}

export const logTailLimit = maxCheckLogLength;

/** `tail` with `chunk` appended, dropping the oldest whole lines past `limit`. */
export function appendTail(tail: LogTail, chunk: string, limit = logTailLimit): LogTail {
  const text = tail.text + chunk;
  if (text.length <= limit) return { text, truncated: tail.truncated };
  const start = text.length - limit;
  const line = text.indexOf("\n", start - 1);
  const cut = line === -1 || line + 1 >= text.length ? start : line + 1;
  return { text: text.slice(cut), truncated: true };
}

export function checkLog(tail: LogTail): ForgeCheckLog {
  return { text: tail.text, truncated: tail.truncated, errors: [], focus: null };
}
