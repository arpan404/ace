import { QUOTED_SECRET_ASSIGNMENT } from "./quoted-assignments.ts";

export interface SensitiveSpan {
  start: number;
  end: number;
  replacement: string;
}

/** Merge overlapping original-byte matches before replacing either spelling. */
export function* sensitiveSpans(
  text: string,
  environment?: RegExp,
): Generator<SensitiveSpan, undefined> {
  const scans = [
    ...(environment ? [{ pattern: environment, replacement: "<ENV>" }] : []),
    { pattern: QUOTED_SECRET_ASSIGNMENT, replacement: "<SECRET>" },
  ].map(({ pattern, replacement }) => {
    const regex = new RegExp(pattern.source, pattern.flags);
    return { regex, replacement, match: regex.exec(text) };
  });
  for (;;) {
    let start = Infinity;
    for (const scan of scans) if (scan.match) start = Math.min(start, scan.match.index);
    if (!Number.isFinite(start)) return;
    let end = start + 1;
    let replacement = "<ENV>";
    let extended = true;
    while (extended) {
      extended = false;
      for (const scan of scans) {
        while (scan.match && scan.match.index < end) {
          const matchEnd = scan.match.index + scan.match[0].length;
          if (matchEnd > end) {
            end = matchEnd;
            extended = true;
          }
          if (scan.replacement === "<SECRET>") replacement = "<SECRET>";
          scan.match = scan.regex.exec(text);
        }
      }
    }
    yield { start, end, replacement };
  }
}

export function redactOriginalText(text: string, environment?: RegExp): string {
  const parts: string[] = [];
  let start = 0;
  for (const span of sensitiveSpans(text, environment)) {
    parts.push(text.slice(start, span.start), span.replacement);
    start = span.end;
  }
  parts.push(text.slice(start));
  return parts.join("");
}
