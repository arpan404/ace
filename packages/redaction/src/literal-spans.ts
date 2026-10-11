import { QUOTED_SECRET_ASSIGNMENT } from "./quoted-assignments.ts";
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
  const quoted = new RegExp(QUOTED_SECRET_ASSIGNMENT.source, QUOTED_SECRET_ASSIGNMENT.flags);
  let assignment = quoted.exec(text);
  for (;;) {
    const start = Math.min(env[index]?.start ?? Infinity, assignment?.index ?? Infinity);
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
      while (assignment && assignment.index < end) {
        const matchEnd = assignment.index + assignment[0].length;
        if (matchEnd > end) {
          end = matchEnd;
          extended = true;
        }
        replacement = "<SECRET>";
        assignment = quoted.exec(text);
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
