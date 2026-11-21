import type { FileOperation, FileSearchFile, FileSearchLine } from "@ace/protocol";
import { CheckoutError, fromCode } from "./checkout-errors.ts";

/*
 * Searching a thread's file contents, the parts every client shares: the query as the person
 * set it, the `files.request` `search` operation it becomes, streamed batches merged into one
 * group per file, the counts the list shows and the sentence a refusal says. Pure.
 */

/** What the person asked for in a content search. */
export interface ContentQuery {
  pattern: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Globs, as typed: comma separated. */
  include: string;
  exclude: string;
}

export const emptyContentQuery: ContentQuery = {
  pattern: "",
  matchCase: false,
  wholeWord: false,
  regex: false,
  include: "",
  exclude: "",
};

/** The most matches one search shows; past it, the list says it was cut. */
export const searchMatchLimit = 2000;

/** The globs of a comma-separated field, trimmed, without empty entries. */
export function searchGlobs(field: string): string[] {
  return field
    .split(",")
    .map((glob) => glob.trim())
    .filter(Boolean)
    .slice(0, 64);
}

/** The `files.request` operation a query runs as. */
export function contentSearchOperation(
  query: ContentQuery,
): Extract<FileOperation, { op: "search" }> {
  return {
    op: "search",
    pattern: query.pattern,
    regex: query.regex,
    case: query.matchCase ? "sensitive" : "insensitive",
    wholeWord: query.wholeWord,
    include: searchGlobs(query.include),
    exclude: searchGlobs(query.exclude),
    includeIgnored: false,
    maxMatches: searchMatchLimit,
    maxFileBytes: 4 * 1024 * 1024,
  };
}

const sentences: Record<string, string> = {
  INVALID_ARGUMENT: "That pattern or file filter isn't valid.",
  FILES_RESTARTING: "File search is starting up on this machine. Try again in a moment.",
};

/** A search's `files.error` code as the sentence the list shows. */
export function searchFailure(code: string): CheckoutError {
  const sentence = sentences[code];
  return sentence ? new CheckoutError(code, sentence) : fromCode(code);
}

/** One hit to open: its file, 1-based line, 0-based column and the match's length. */
export interface SearchHit {
  path: string;
  line: number;
  column: number;
  length: number;
}

/** A hit's identity in the list: one row per matching line of a file. */
export const hitKey = (path: string, line: number) => `${path}:${line}`;

/** The hit a result line opens: its first match. */
export function lineHit(path: string, line: FileSearchLine): SearchHit {
  const [start, end] = line.ranges[0] ?? [0, 0];
  return { path, line: line.line, column: line.column + start, length: end - start };
}

/** A file's matches as the list counts them: each highlighted range, at least one a line. */
export function matchCount(file: FileSearchFile): number {
  let total = 0;
  for (const line of file.lines) total += Math.max(1, line.ranges.length);
  return total;
}

/** Results found so far: files in the order found, with lines and matches counted. */
export interface SearchFound {
  files: readonly FileSearchFile[];
  lines: number;
  matches: number;
}

export const nothingFound: SearchFound = { files: [], lines: 0, matches: 0 };

/** `into` with a streamed batch merged in: a file split across batches stays one group. */
export function mergeSearchBatch(into: SearchFound, batch: readonly FileSearchFile[]): SearchFound {
  const files = [...into.files];
  let lines = into.lines;
  let matches = into.matches;
  for (const file of batch) {
    lines += file.lines.length;
    matches += matchCount(file);
    const last = files.at(-1);
    if (last?.path === file.path)
      files[files.length - 1] = { path: file.path, lines: [...last.lines, ...file.lines] };
    else files.push(file);
  }
  return { files, lines, matches };
}

const count = (value: number) => value.toLocaleString();

/** "1 result", "2,000 results". */
export const countedWords = (value: number, one: string, many: string) =>
  `${count(value)} ${value === 1 ? one : many}`;

/** "12 results in 3 files". */
export function searchTally(matches: number, files: number): string {
  return `${countedWords(matches, "result", "results")} in ${countedWords(files, "file", "files")}`;
}

/** What a list cut at the match limit says under its results. */
export function truncatedNote(matches: number): string {
  return `Showing the first ${count(matches)} results. Narrow the search to see the rest.`;
}
