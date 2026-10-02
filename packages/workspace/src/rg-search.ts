import { rgMatches } from "./rg-parser.ts";
import { command } from "./process.ts";
import { WorkspaceError, type Match } from "./types.ts";

/** Parse JSONL incrementally; the child is killed and reaped at the match limit. */
export async function rgSearch(
  binary: string,
  request: {
    text: string;
    path: string;
    query: string;
    regex: boolean;
    caseSensitive: boolean;
    limit: number;
  },
  signal?: AbortSignal,
): Promise<Match[]> {
  const matches: Match[] = [];
  const args = [
    "--json",
    "--no-config",
    "--encoding",
    "utf-8",
    "--text",
    "--threads",
    "1",
    request.caseSensitive ? "--case-sensitive" : "--ignore-case",
  ];
  if (!request.regex) args.push("--fixed-strings");
  args.push("-e", request.query, "--", "-");
  const result = await command(binary, args, {
    input: Buffer.from(request.text),
    ...(signal ? { signal } : {}),
    onLine(line) {
      for (const match of rgMatches(line, request.path, request.limit - matches.length)) {
        matches.push(match);
        if (matches.length >= request.limit) return false;
      }
      return true;
    },
  });
  if (result.code !== 0 && result.code !== 1)
    throw new WorkspaceError("SEARCH_FAILED", result.stderr || "ripgrep failed");
  return matches;
}
