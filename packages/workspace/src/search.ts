import type { WorkspaceRuntime } from "./runtime.ts";
import { matchesGlob } from "node:path";
import type { GitIgnore } from "./ignore.ts";
import { NodeSearch } from "./node-search.ts";
import { command } from "./process.ts";
import { querySource, searchText } from "./query.ts";
import { read } from "./read.ts";
import { rgSearch } from "./rg-search.ts";
import { transient, type SafeRoot } from "./safety.ts";
import { tree } from "./tree.ts";
import {
  aborted,
  errorCode,
  integer,
  READ_CAP,
  SEARCH_BUDGET,
  TREE_CAP,
  WorkspaceError,
  type SearchOptions,
  type SearchResult,
} from "./types.ts";

async function backend(
  binary: string | null,
  runtime: WorkspaceRuntime,
  signal?: AbortSignal,
): Promise<"node" | "ripgrep"> {
  if (binary === null) return "node";
  try {
    const result = await command(binary, ["--version"], {
      spawn: runtime.spawn,
      ...(signal ? { signal } : {}),
    });
    if (result.code !== 0)
      throw new WorkspaceError("SEARCH_FAILED", result.stderr || "Cannot run ripgrep");
    return "ripgrep";
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "node";
    throw error;
  }
}
export async function search(
  safe: SafeRoot,
  ignore: GitIgnore,
  binary: string | null,
  options: SearchOptions,
  runtime: WorkspaceRuntime,
): Promise<SearchResult> {
  aborted(options.signal);
  const expression = querySource(options);
  const limit = integer(options.limit, "limit", 1, 10_000);
  const budget = integer(options.byteBudget ?? SEARCH_BUDGET, "byteBudget", 1, SEARCH_BUDGET);
  if (options.glob !== undefined && (options.glob.length > 4096 || options.glob.includes("\0"))) {
    throw new WorkspaceError("INVALID_ARGUMENT", "Invalid search glob");
  }
  const selected = await backend(binary, runtime, options.signal);
  const result: SearchResult = {
    matches: [],
    truncated: false,
    bytesScanned: 0,
    backend: selected,
  };
  const fallback = selected === "node" ? new NodeSearch(runtime) : undefined;
  try {
    for await (const entry of tree(safe, ignore, {
      dir: "",
      depth: TREE_CAP,
      includeIgnored: false,
      ...(options.signal ? { signal: options.signal } : {}),
    })) {
      aborted(options.signal);
      if (
        entry.type !== "file" ||
        (options.glob !== undefined && !matchesGlob(entry.path, options.glob))
      )
        continue;
      // Skip oversized files rather than treating a cut prefix as a complete file.
      if (entry.size > READ_CAP || entry.size > budget - result.bytesScanned) {
        result.truncated = true;
        continue;
      }
      try {
        const content = await read(safe, {
          path: entry.path,
          length: Math.min(READ_CAP, budget - result.bytesScanned),
        });
        aborted(options.signal);
        if (content.binary) {
          result.bytesScanned += Math.min(content.size, 8192, budget - result.bytesScanned);
          continue;
        }
        result.bytesScanned += content.bytesRead;
        if (content.truncated || content.text.includes("\0")) {
          result.truncated ||= content.truncated;
          continue;
        }
        const remaining = limit - result.matches.length;
        const text = searchText(content.text);
        const matches = fallback
          ? await fallback.match(
              {
                text,
                path: entry.path,
                source: expression,
                caseSensitive: options.caseSensitive ?? true,
                limit: remaining,
              },
              options.signal,
            )
          : await rgSearch(
              binary ?? "rg",
              {
                text,
                path: entry.path,
                query: options.regex ? expression : options.query,
                regex: options.regex ?? false,
                caseSensitive: options.caseSensitive ?? true,
                limit: remaining,
              },
              options.signal,
              runtime.spawn,
            );
        result.matches.push(...matches);
        if (result.matches.length >= limit) {
          result.truncated = true;
          break;
        }
      } catch (error) {
        if (!transient(error)) throw error;
      }
    }
    aborted(options.signal);
    return result;
  } finally {
    await fallback?.dispose();
  }
}
