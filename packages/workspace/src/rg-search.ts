import { rgStream } from "./rg-stream.ts";
import { command } from "./process.ts";
import type { WorkspaceRuntime } from "./runtime.ts";
import { WorkspaceError, type Match } from "./types.ts";

/** One process searches a bounded batch of pipes fed from confined descriptors. */
export async function rgSearch(
  runtime: WorkspaceRuntime,
  binary: string,
  request: {
    files: { path: string; input: AsyncIterable<Buffer> }[];
    query: string;
    regex: boolean;
    caseSensitive: boolean;
    limit: number;
    bytes: number;
  },
  signal?: AbortSignal,
): Promise<Match[]> {
  const matches: Match[] = [];
  const paths = new Map(request.files.map((file, index) => [`/dev/fd/${index + 3}`, file.path]));
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
  args.push("-e", request.query, "--", ...paths.keys());
  const parser = rgStream(paths, (match) => {
    matches.push(match);
    return matches.length < request.limit;
  });
  const result = await command(
    binary,
    args,
    {
      inputs: request.files.map((file) => file.input),
      outputCap: request.bytes * 36 + request.limit * 1024 + 8192 * request.files.length,
      ...(signal ? { signal } : {}),
      onChunk: (chunk) => parser.push(chunk),
    },
    runtime,
  );
  parser.finish();
  if (result.code !== 0 && result.code !== 1)
    throw new WorkspaceError("SEARCH_FAILED", result.stderr || "ripgrep failed");
  return matches;
}
