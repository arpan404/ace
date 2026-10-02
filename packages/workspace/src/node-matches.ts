import type { z } from "zod";
import type { workerRequest } from "./worker-messages.ts";
import type { Match } from "./types.ts";

export function nodeMatches(request: z.infer<typeof workerRequest>): Match[] {
  const expression = new RegExp(request.source, request.caseSensitive ? "gu" : "giu");
  const matches: Match[] = [];
  const lines = request.text.split("\n");
  for (const [index, line] of lines.entries()) {
    // A trailing newline doesn't create a searchable extra empty line in rg.
    if (index === lines.length - 1 && !line) break;
    expression.lastIndex = 0;
    let previousEnd = -1;
    let previousIndex = 0;
    let byteOffset = 0;
    const preview = line.slice(0, 512);
    for (const match of line.matchAll(expression)) {
      // rg suppresses an empty match immediately adjacent to a prior match.
      if (!match[0].length && match.index === previousEnd) continue;
      previousEnd = match.index + match[0].length;
      byteOffset += Buffer.byteLength(line.slice(previousIndex, match.index));
      previousIndex = match.index;
      matches.push({
        path: request.path,
        line: request.lineOffset + index + 1,
        column: byteOffset + 1,
        preview,
      });
      if (matches.length >= request.limit) break;
    }
    if (matches.length >= request.limit) break;
  }
  return matches;
}
