// MessagePort.postMessage has no browser targetOrigin argument.
/* eslint-disable unicorn/require-post-message-target-origin */
import { parentPort } from "node:worker_threads";
import type { Match } from "./types.ts";

interface Request {
  text: string;
  path: string;
  source: string;
  caseSensitive: boolean;
  limit: number;
}
parentPort?.on("message", (request: Request) => {
  try {
    const expression = new RegExp(request.source, request.caseSensitive ? "gu" : "giu");
    const matches: Match[] = [];
    const lines = request.text.split("\n");
    for (const [index, line] of lines.entries()) {
      // A trailing newline doesn't create a searchable extra empty line in rg.
      if (index === lines.length - 1 && !line) break;
      expression.lastIndex = 0;
      let previousEnd = -1;
      for (const match of line.matchAll(expression)) {
        // rg suppresses an empty match immediately adjacent to a prior match.
        if (!match[0].length && match.index === previousEnd) continue;
        previousEnd = match.index + match[0].length;
        matches.push({
          path: request.path,
          line: index + 1,
          column: Buffer.byteLength(line.slice(0, match.index)) + 1,
          preview: line.replace(/\r$/, "").slice(0, 512),
        });
        if (matches.length >= request.limit) break;
      }
      if (matches.length >= request.limit) break;
    }
    parentPort?.postMessage({ matches });
  } catch (error) {
    parentPort?.postMessage({ error: String(error) });
  }
});
