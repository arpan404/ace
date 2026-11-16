/*
 * One `Range: bytes=…` header against a file of `size` bytes (RFC 9110 §14.1.2), as a Suit's
 * video is served (ADR 0169). Pure. Only a single range is honoured; a list of them gets the
 * whole file, which the RFC allows.
 */

/** Inclusive byte offsets. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * The range to send: undefined for the whole file (no header, or one this server ignores),
 * `unsatisfiable` for a range that starts past the end (answered `416`).
 */
export function byteRange(
  header: string | undefined,
  size: number,
): ByteRange | "unsatisfiable" | undefined {
  if (header === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return undefined;
  if (first === "") {
    // A suffix: the last `last` bytes.
    const length = Number(last);
    if (!Number.isSafeInteger(length) || length === 0) return "unsatisfiable";
    if (size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(first);
  if (!Number.isSafeInteger(start) || start >= size) return "unsatisfiable";
  const end = last === "" ? size - 1 : Number(last);
  if (!Number.isSafeInteger(end) || end < start) return undefined;
  return { start, end: Math.min(end, size - 1) };
}
