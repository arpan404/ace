import { rgStream } from "./rg-stream.ts";
import { command } from "./process.ts";
import type { WorkspaceRuntime } from "./runtime.ts";
import { WorkspaceError, type Match } from "./types.ts";

/** Search confined byte streams: POSIX fd batches or per-file Windows stdin. */
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
  const flags = [
    "--json",
    "--no-config",
    "--encoding",
    "utf-8",
    "--text",
    "--threads",
    "1",
    request.caseSensitive ? "--case-sensitive" : "--ignore-case",
  ];
  if (!request.regex) flags.push("--fixed-strings");
  const outputCap = request.bytes * 36 + request.limit * 1024 + 8192 * request.files.length;
  const onMatch = (match: Match) => {
    matches.push(match);
    return matches.length < request.limit;
  };
  if (runtime.platform === "win32") {
    for (const file of request.files) {
      if (matches.length >= request.limit) break;
      const parser = rgStream(new Map([["<stdin>", file.path]]), onMatch);
      const result = await command(
        binary,
        [...flags, "-e", request.query, "--", "-"],
        {
          input: file.input,
          outputCap,
          ...(signal ? { signal } : {}),
          onChunk: (chunk) => parser.push(chunk),
        },
        runtime,
      );
      parser.finish();
      if (result.code !== 0 && result.code !== 1)
        throw new WorkspaceError("SEARCH_FAILED", result.stderr || "ripgrep failed");
    }
    return matches;
  }
  const paths = new Map(request.files.map((file, index) => [`/dev/fd/${index + 3}`, file.path]));
  const args = [...flags, "-e", request.query, "--", ...paths.keys()];
  const parser = rgStream(paths, onMatch);
  const result = await command(
    binary,
    args,
    {
      inputs: request.files.map((file) => file.input),
      outputCap,
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
