import { CREDENTIAL_PATTERNS } from "./credential-patterns.ts";
import type { EnvironmentMatcher } from "./environment.ts";

export interface SensitiveSpan {
  start: number;
  end: number;
  replacement: string;
}

/** Merge overlapping original-byte matches before replacing either spelling. */
export function* sensitiveSpans(
  text: string,
  environment?: EnvironmentMatcher,
): Generator<SensitiveSpan, undefined> {
  const env = environment?.spans(text) ?? [];
  let index = 0;
  const scans = CREDENTIAL_PATTERNS.map(({ pattern, prefix, suffix }) => {
    const regex = new RegExp(pattern.source, pattern.flags);
    const next = () => {
      const match = regex.exec(text);
      return (
        match && {
          start: match.index + (prefix === undefined ? 0 : (match[1]?.length ?? 0) + prefix),
          end: match.index + match[0].length - (suffix ?? 0),
        }
      );
    };
    return { next, match: next() };
  });
  for (;;) {
    let start = env[index]?.start ?? Infinity;
    for (const scan of scans) if (scan.match) start = Math.min(start, scan.match.start);
    if (!Number.isFinite(start)) return;
    let end = start + 1;
    let replacement = "<ENV>";
    let extended = true;
    while (extended) {
      extended = false;
      while (env[index] && (env[index]?.start ?? Infinity) < end) {
        const matchEnd = env[index]?.end ?? end;
        if (matchEnd > end) {
          end = matchEnd;
          extended = true;
        }
        index++;
      }
      for (const scan of scans) {
        while (scan.match && scan.match.start < end) {
          if (scan.match.end > end) {
            end = scan.match.end;
            extended = true;
          }
          replacement = "<SECRET>";
          scan.match = scan.next();
        }
      }
    }
    yield { start, end, replacement };
  }
}

export function redactOriginalText(text: string, environment?: EnvironmentMatcher): string {
  const parts: string[] = [];
  let start = 0;
  for (const span of sensitiveSpans(text, environment)) {
    parts.push(text.slice(start, span.start), span.replacement);
    start = span.end;
  }
  parts.push(text.slice(start));
  return parts.join("");
}
