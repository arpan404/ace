import { matchesGlob } from "node:path";
import type { GitIgnore } from "./ignore.ts";
import { NodeSearch } from "./node-search.ts";
import { command } from "./process.ts";
import { querySource } from "./query.ts";
import { rgSearch } from "./rg-search.ts";
import { searchContent, linePackets, type SearchContent } from "./search-content.ts";
import { transient, type SafeRoot } from "./safety.ts";
import { tree } from "./tree.ts";
import {
  aborted,
  errorCode,
  integer,
  SEARCH_BUDGET,
  TREE_CAP,
  WorkspaceError,
  type SearchOptions,
  type SearchResult,
} from "./types.ts";

async function backend(
  safe: SafeRoot,
  binary: string | null,
  signal?: AbortSignal,
): Promise<"node" | "ripgrep"> {
  if (binary === null) return "node";
  try {
    const result = await command(binary, ["--version"], signal ? { signal } : {}, safe.runtime);
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
): Promise<SearchResult> {
  aborted(options.signal);
  const expression = querySource(options);
  const limit = integer(options.limit, "limit", 1, 10_000);
  const budget = integer(options.byteBudget ?? SEARCH_BUDGET, "byteBudget", 1, SEARCH_BUDGET);
  if (options.glob !== undefined && (options.glob.length > 4096 || options.glob.includes("\0")))
    throw new WorkspaceError("INVALID_ARGUMENT", "Invalid search glob");
  const selected = await backend(safe, binary, options.signal);
  const result: SearchResult = {
    matches: [],
    truncated: false,
    bytesScanned: 0,
    backend: selected,
  };
  const fallback = selected === "node" ? new NodeSearch(safe.runtime) : undefined;
  let batch: { path: string; content: SearchContent }[] = [];
  async function drain(): Promise<void> {
    if (!batch.length) return;
    const owned = batch;
    batch = [];
    try {
      if (fallback) {
        for (const file of owned) {
          for await (const packet of linePackets(file.content.input())) {
            const matches = await fallback.match(
              {
                ...packet,
                path: file.path,
                source: expression,
                caseSensitive: options.caseSensitive ?? true,
                limit: limit - result.matches.length,
              },
              options.signal,
            );
            result.matches.push(...matches);
            if (result.matches.length >= limit) return;
          }
        }
      } else {
        result.matches.push(
          ...(await rgSearch(
            safe.runtime,
            binary ?? "rg",
            {
              files: owned.map((file) => ({ path: file.path, input: file.content.input() })),
              query: options.regex ? expression : options.query,
              regex: options.regex ?? false,
              caseSensitive: options.caseSensitive ?? true,
              limit: limit - result.matches.length,
              bytes: owned.reduce((total, file) => total + file.content.bytesScanned, 0),
            },
            options.signal,
          )),
        );
      }
    } finally {
      await Promise.all(owned.map((file) => file.content.close()));
    }
  }
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
      if (result.bytesScanned >= budget) {
        result.truncated = true;
        break;
      }
      try {
        const content = await searchContent(
          safe,
          entry.path,
          budget - result.bytesScanned,
          options.signal,
        );
        result.bytesScanned += content.bytesScanned;
        result.truncated ||= content.truncated;
        if (content.binary) {
          await content.close();
          continue;
        }
        batch.push({ path: entry.path, content });
        if (batch.length >= (fallback ? 1 : 64)) await drain();
        if (result.matches.length >= limit) {
          result.truncated = true;
          break;
        }
      } catch (error) {
        if (!transient(error)) throw error;
      }
    }
    await drain();
    if (result.matches.length >= limit) result.truncated = true;
    aborted(options.signal);
    return result;
  } finally {
    await Promise.all(batch.map((file) => file.content.close()));
    await fallback?.dispose();
  }
}
