import * as OS from "node:os";
import fsPromises from "node:fs/promises";
import type { Dirent } from "node:fs";

import { Cache, Duration, Effect, Exit, Layer, Option, Path } from "effect";

import { type FilesystemBrowseInput, type ProjectEntry } from "@ace/contracts";
import { isExplicitRelativePath, isWindowsAbsolutePath } from "@ace/shared/path";

import { GitCore } from "../../git/Services/GitCore.ts";
import {
  WorkspaceEntries,
  WorkspaceEntriesBrowseError,
  WorkspaceEntriesError,
  type WorkspaceEntriesShape,
} from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";

const WORKSPACE_CACHE_TTL_MS = 15_000;
const WORKSPACE_CACHE_MAX_KEYS = 4;
const WORKSPACE_INDEX_MAX_ENTRIES = 25_000;
const WORKSPACE_SCAN_READDIR_CONCURRENCY = 32;
const WORKSPACE_CONTENT_SEARCH_MAX_FILE_BYTES = 1_000_000;
const WORKSPACE_CONTENT_SEARCH_MAX_FILES = 3_000;
const WORKSPACE_CONTENT_SEARCH_READ_CONCURRENCY = 24;
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".convex",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  ".cache",
]);
const IGNORED_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "Desktop.ini"]);

interface WorkspaceIndex {
  scannedAt: number;
  entries: SearchableWorkspaceEntry[];
  truncated: boolean;
}

interface SearchableWorkspaceEntry extends ProjectEntry {
  normalizedPath: string;
  normalizedName: string;
}

interface RankedWorkspaceEntry {
  entry: SearchableWorkspaceEntry;
  score: number;
}

type WorkspaceSearchQuery =
  | {
      kind: "content-regex";
      regex: RegExp;
    }
  | {
      kind: "content-substring";
      query: string;
    }
  | {
      kind: "invalid";
    }
  | {
      kind: "path-fuzzy";
      query: string;
    }
  | {
      kind: "path-regex";
      regex: RegExp;
    };

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") {
    return OS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(OS.homedir(), input.slice(2));
  }
  return input;
}

function parentPathOf(input: string): string | undefined {
  const separatorIndex = input.lastIndexOf("/");
  if (separatorIndex === -1) {
    return undefined;
  }
  return input.slice(0, separatorIndex);
}

function basenameOf(input: string): string {
  const separatorIndex = input.lastIndexOf("/");
  if (separatorIndex === -1) {
    return input;
  }
  return input.slice(separatorIndex + 1);
}

function isIgnoredFileName(name: string): boolean {
  return IGNORED_FILE_NAMES.has(name) || name.startsWith("._");
}

function isIgnoredFilePath(relativePath: string): boolean {
  return isIgnoredFileName(basenameOf(relativePath));
}

function toSearchableWorkspaceEntry(entry: ProjectEntry): SearchableWorkspaceEntry {
  const normalizedPath = entry.path.toLowerCase();
  return {
    ...entry,
    normalizedPath,
    normalizedName: basenameOf(normalizedPath),
  };
}

function toPublicProjectEntry(entry: SearchableWorkspaceEntry): ProjectEntry {
  return {
    path: entry.path,
    kind: entry.kind,
    ...(entry.parentPath ? { parentPath: entry.parentPath } : {}),
  };
}

function normalizeQuery(input: string): string {
  return input
    .trim()
    .replace(/^[@./]+/, "")
    .toLowerCase();
}

function looksLikeRegexLiteral(input: string): boolean {
  return /^\/.+\/[dgimsuvy]*$/i.test(input.trim());
}

function compileRegexPattern(input: string, defaultFlags: string): RegExp | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (looksLikeRegexLiteral(trimmed)) {
    const literalMatch = trimmed.match(/^\/(.+)\/([dgimsuvy]*)$/i);
    if (!literalMatch) {
      return null;
    }
    try {
      return new RegExp(literalMatch[1] ?? "", literalMatch[2] ?? "");
    } catch {
      return null;
    }
  }
  try {
    return new RegExp(trimmed, defaultFlags);
  } catch {
    return null;
  }
}

function parseWorkspaceSearchQuery(query: string): WorkspaceSearchQuery {
  const trimmed = query.trim();
  const lowerTrimmed = trimmed.toLowerCase();

  if (lowerTrimmed.startsWith("inre:")) {
    const regex = compileRegexPattern(trimmed.slice(5), "i");
    if (!regex) {
      return { kind: "invalid" };
    }
    return {
      kind: "content-regex",
      regex,
    };
  }

  if (lowerTrimmed.startsWith("in:") || lowerTrimmed.startsWith("content:")) {
    const rawQuery = trimmed.slice(lowerTrimmed.startsWith("in:") ? 3 : 8).trim();
    if (rawQuery.length === 0) {
      return { kind: "invalid" };
    }
    if (looksLikeRegexLiteral(rawQuery)) {
      const regex = compileRegexPattern(rawQuery, "i");
      if (!regex) {
        return { kind: "invalid" };
      }
      return {
        kind: "content-regex",
        regex,
      };
    }
    return {
      kind: "content-substring",
      query: rawQuery.toLowerCase(),
    };
  }

  if (lowerTrimmed.startsWith("re:")) {
    const regex = compileRegexPattern(trimmed.slice(3), "i");
    if (!regex) {
      return { kind: "invalid" };
    }
    return {
      kind: "path-regex",
      regex,
    };
  }

  if (looksLikeRegexLiteral(trimmed)) {
    const regex = compileRegexPattern(trimmed, "i");
    if (!regex) {
      return { kind: "invalid" };
    }
    return {
      kind: "path-regex",
      regex,
    };
  }

  return {
    kind: "path-fuzzy",
    query: normalizeQuery(trimmed),
  };
}

function resetAndTestRegex(regex: RegExp, value: string): boolean {
  regex.lastIndex = 0;
  return regex.test(value);
}

function scoreSubsequenceMatch(value: string, query: string): number | null {
  if (!query) return 0;

  let queryIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;

  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) {
      continue;
    }

    if (firstMatchIndex === -1) {
      firstMatchIndex = valueIndex;
    }
    if (previousMatchIndex !== -1) {
      gapPenalty += valueIndex - previousMatchIndex - 1;
    }

    previousMatchIndex = valueIndex;
    queryIndex += 1;
    if (queryIndex === query.length) {
      const spanPenalty = valueIndex - firstMatchIndex + 1 - query.length;
      const lengthPenalty = Math.min(64, value.length - query.length);
      return firstMatchIndex * 2 + gapPenalty * 3 + spanPenalty + lengthPenalty;
    }
  }

  return null;
}

function scoreEntry(entry: SearchableWorkspaceEntry, query: string): number | null {
  if (!query) {
    return entry.kind === "directory" ? 0 : 1;
  }

  const { normalizedPath, normalizedName } = entry;

  if (normalizedName === query) return 0;
  if (normalizedPath === query) return 1;
  if (normalizedName.startsWith(query)) return 2;
  if (normalizedPath.startsWith(query)) return 3;
  if (normalizedPath.includes(`/${query}`)) return 4;
  if (normalizedName.includes(query)) return 5;
  if (normalizedPath.includes(query)) return 6;

  const nameFuzzyScore = scoreSubsequenceMatch(normalizedName, query);
  if (nameFuzzyScore !== null) {
    return 100 + nameFuzzyScore;
  }

  const pathFuzzyScore = scoreSubsequenceMatch(normalizedPath, query);
  if (pathFuzzyScore !== null) {
    return 200 + pathFuzzyScore;
  }

  return null;
}

function compareRankedWorkspaceEntries(
  left: RankedWorkspaceEntry,
  right: RankedWorkspaceEntry,
): number {
  const scoreDelta = left.score - right.score;
  if (scoreDelta !== 0) return scoreDelta;
  return left.entry.path.localeCompare(right.entry.path);
}

function findInsertionIndex(
  rankedEntries: RankedWorkspaceEntry[],
  candidate: RankedWorkspaceEntry,
): number {
  let low = 0;
  let high = rankedEntries.length;

  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const current = rankedEntries[middle];
    if (!current) {
      break;
    }

    if (compareRankedWorkspaceEntries(candidate, current) < 0) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  return low;
}

function insertRankedEntry(
  rankedEntries: RankedWorkspaceEntry[],
  candidate: RankedWorkspaceEntry,
  limit: number,
): void {
  if (limit <= 0) {
    return;
  }

  const insertionIndex = findInsertionIndex(rankedEntries, candidate);
  if (rankedEntries.length < limit) {
    rankedEntries.splice(insertionIndex, 0, candidate);
    return;
  }

  if (insertionIndex >= limit) {
    return;
  }

  rankedEntries.splice(insertionIndex, 0, candidate);
  rankedEntries.pop();
}

function isPathInIgnoredDirectory(relativePath: string): boolean {
  const firstSegment = relativePath.split("/")[0];
  if (!firstSegment) return false;
  return IGNORED_DIRECTORY_NAMES.has(firstSegment);
}

function directoryAncestorsOf(relativePath: string): string[] {
  const segments = relativePath.split("/").filter((segment) => segment.length > 0);
  if (segments.length <= 1) return [];

  const directories: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    directories.push(segments.slice(0, index).join("/"));
  }
  return directories;
}

const processErrorDetail = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const resolveBrowseTarget = (
  input: FilesystemBrowseInput,
  pathService: Path.Path,
): Effect.Effect<string, WorkspaceEntriesBrowseError> =>
  Effect.gen(function* () {
    if (process.platform !== "win32" && isWindowsAbsolutePath(input.partialPath)) {
      return yield* new WorkspaceEntriesBrowseError({
        cwd: input.cwd,
        partialPath: input.partialPath,
        operation: "workspaceEntries.resolveBrowseTarget",
        detail: "Windows-style paths are only supported on Windows.",
      });
    }

    if (!isExplicitRelativePath(input.partialPath)) {
      return pathService.resolve(expandHomePath(input.partialPath, pathService));
    }

    if (!input.cwd) {
      return yield* new WorkspaceEntriesBrowseError({
        cwd: input.cwd,
        partialPath: input.partialPath,
        operation: "workspaceEntries.resolveBrowseTarget",
        detail: "Relative filesystem browse paths require a current project.",
      });
    }

    return pathService.resolve(expandHomePath(input.cwd, pathService), input.partialPath);
  });

export const makeWorkspaceEntries = Effect.gen(function* () {
  const path = yield* Path.Path;
  const gitOption = yield* Effect.serviceOption(GitCore);
  const workspacePaths = yield* WorkspacePaths;

  const isInsideGitWorkTree = (cwd: string): Effect.Effect<boolean> =>
    Option.match(gitOption, {
      onSome: (git) => git.isInsideWorkTree(cwd).pipe(Effect.catch(() => Effect.succeed(false))),
      onNone: () => Effect.succeed(false),
    });

  const filterGitIgnoredPaths = (
    cwd: string,
    relativePaths: string[],
  ): Effect.Effect<string[], never> =>
    Option.match(gitOption, {
      onSome: (git) =>
        git.filterIgnoredPaths(cwd, relativePaths).pipe(
          Effect.map((paths) => [...paths]),
          Effect.catch(() => Effect.succeed(relativePaths)),
        ),
      onNone: () => Effect.succeed(relativePaths),
    });

  const buildWorkspaceIndexFromGit = Effect.fn("WorkspaceEntries.buildWorkspaceIndexFromGit")(
    function* (cwd: string) {
      if (Option.isNone(gitOption)) {
        return null;
      }
      if (!(yield* isInsideGitWorkTree(cwd))) {
        return null;
      }

      const listedFiles = yield* gitOption.value
        .listWorkspaceFiles(cwd)
        .pipe(Effect.catch(() => Effect.succeed(null)));

      if (!listedFiles) {
        return null;
      }

      const listedPaths = [...listedFiles.paths]
        .map((entry) => toPosixPath(entry))
        .filter(
          (entry) =>
            entry.length > 0 && !isPathInIgnoredDirectory(entry) && !isIgnoredFilePath(entry),
        );
      const filePaths = yield* filterGitIgnoredPaths(cwd, listedPaths);

      const directorySet = new Set<string>();
      for (const filePath of filePaths) {
        for (const directoryPath of directoryAncestorsOf(filePath)) {
          if (!isPathInIgnoredDirectory(directoryPath)) {
            directorySet.add(directoryPath);
          }
        }
      }

      const directoryEntries = [...directorySet]
        .toSorted((left, right) => left.localeCompare(right))
        .map(
          (directoryPath): ProjectEntry => ({
            path: directoryPath,
            kind: "directory",
            parentPath: parentPathOf(directoryPath),
          }),
        )
        .map(toSearchableWorkspaceEntry);
      const fileEntries = [...new Set(filePaths)]
        .toSorted((left, right) => left.localeCompare(right))
        .map(
          (filePath): ProjectEntry => ({
            path: filePath,
            kind: "file",
            parentPath: parentPathOf(filePath),
          }),
        )
        .map(toSearchableWorkspaceEntry);

      const entries = [...directoryEntries, ...fileEntries];
      return {
        scannedAt: Date.now(),
        entries: entries.slice(0, WORKSPACE_INDEX_MAX_ENTRIES),
        truncated: listedFiles.truncated || entries.length > WORKSPACE_INDEX_MAX_ENTRIES,
      };
    },
  );

  const readDirectoryEntries = Effect.fn("WorkspaceEntries.readDirectoryEntries")(function* (
    cwd: string,
    relativeDir: string,
  ): Effect.fn.Return<
    { readonly relativeDir: string; readonly dirents: Dirent[] | null },
    WorkspaceEntriesError
  > {
    return yield* Effect.tryPromise({
      try: async () => {
        const absoluteDir = relativeDir ? path.join(cwd, relativeDir) : cwd;
        const dirents = await fsPromises.readdir(absoluteDir, { withFileTypes: true });
        return { relativeDir, dirents };
      },
      catch: (cause) =>
        new WorkspaceEntriesError({
          cwd,
          operation: "workspaceEntries.readDirectoryEntries",
          detail: processErrorDetail(cause),
          cause,
        }),
    }).pipe(
      Effect.catchIf(
        () => relativeDir.length > 0,
        () => Effect.succeed({ relativeDir, dirents: null }),
      ),
    );
  });

  const buildWorkspaceIndexFromFilesystem = Effect.fn(
    "WorkspaceEntries.buildWorkspaceIndexFromFilesystem",
  )(function* (cwd: string): Effect.fn.Return<WorkspaceIndex, WorkspaceEntriesError> {
    const shouldFilterWithGitIgnore = yield* isInsideGitWorkTree(cwd);

    let pendingDirectories: string[] = [""];
    const entries: SearchableWorkspaceEntry[] = [];
    let truncated = false;

    while (pendingDirectories.length > 0 && !truncated) {
      const currentDirectories = pendingDirectories;
      pendingDirectories = [];

      const directoryEntries = yield* Effect.forEach(
        currentDirectories,
        (relativeDir) => readDirectoryEntries(cwd, relativeDir),
        { concurrency: WORKSPACE_SCAN_READDIR_CONCURRENCY },
      );

      const candidateEntriesByDirectory = directoryEntries.map((directoryEntry) => {
        const { relativeDir, dirents } = directoryEntry;
        if (!dirents) return [] as Array<{ dirent: Dirent; relativePath: string }>;

        dirents.sort((left, right) => left.name.localeCompare(right.name));
        const candidates: Array<{ dirent: Dirent; relativePath: string }> = [];
        for (const dirent of dirents) {
          if (!dirent.name || dirent.name === "." || dirent.name === "..") {
            continue;
          }
          if (isIgnoredFileName(dirent.name)) {
            continue;
          }
          if (dirent.isDirectory() && IGNORED_DIRECTORY_NAMES.has(dirent.name)) {
            continue;
          }
          if (!dirent.isDirectory() && !dirent.isFile()) {
            continue;
          }

          const relativePath = toPosixPath(
            relativeDir ? path.join(relativeDir, dirent.name) : dirent.name,
          );
          if (isPathInIgnoredDirectory(relativePath)) {
            continue;
          }
          candidates.push({ dirent, relativePath });
        }
        return candidates;
      });

      const candidatePaths = candidateEntriesByDirectory.flatMap((candidateEntries) =>
        candidateEntries.map((entry) => entry.relativePath),
      );
      const allowedPathSet = shouldFilterWithGitIgnore
        ? new Set(yield* filterGitIgnoredPaths(cwd, candidatePaths))
        : null;

      for (const candidateEntries of candidateEntriesByDirectory) {
        for (const candidate of candidateEntries) {
          if (allowedPathSet && !allowedPathSet.has(candidate.relativePath)) {
            continue;
          }

          const entry = toSearchableWorkspaceEntry({
            path: candidate.relativePath,
            kind: candidate.dirent.isDirectory() ? "directory" : "file",
            parentPath: parentPathOf(candidate.relativePath),
          });
          entries.push(entry);

          if (candidate.dirent.isDirectory()) {
            pendingDirectories.push(candidate.relativePath);
          }

          if (entries.length >= WORKSPACE_INDEX_MAX_ENTRIES) {
            truncated = true;
            break;
          }
        }

        if (truncated) {
          break;
        }
      }
    }

    return {
      scannedAt: Date.now(),
      entries,
      truncated,
    };
  });

  const buildWorkspaceIndex = Effect.fn("WorkspaceEntries.buildWorkspaceIndex")(function* (
    cwd: string,
  ): Effect.fn.Return<WorkspaceIndex, WorkspaceEntriesError> {
    const gitIndexed = yield* buildWorkspaceIndexFromGit(cwd);
    if (gitIndexed) {
      return gitIndexed;
    }
    return yield* buildWorkspaceIndexFromFilesystem(cwd);
  });

  const workspaceIndexCache = yield* Cache.makeWith<string, WorkspaceIndex, WorkspaceEntriesError>({
    capacity: WORKSPACE_CACHE_MAX_KEYS,
    lookup: buildWorkspaceIndex,
    timeToLive: (exit) =>
      Exit.isSuccess(exit) ? Duration.millis(WORKSPACE_CACHE_TTL_MS) : Duration.zero,
  });

  const normalizeWorkspaceRoot = Effect.fn("WorkspaceEntries.normalizeWorkspaceRoot")(function* (
    cwd: string,
  ): Effect.fn.Return<string, WorkspaceEntriesError> {
    return yield* workspacePaths.normalizeWorkspaceRoot(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceEntriesError({
            cwd,
            operation: "workspaceEntries.normalizeWorkspaceRoot",
            detail: cause.message,
            cause,
          }),
      ),
    );
  });

  const invalidate: WorkspaceEntriesShape["invalidate"] = Effect.fn("WorkspaceEntries.invalidate")(
    function* (cwd) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(cwd).pipe(
        Effect.catch(() => Effect.succeed(cwd)),
      );
      yield* Cache.invalidate(workspaceIndexCache, cwd);
      if (normalizedCwd !== cwd) {
        yield* Cache.invalidate(workspaceIndexCache, normalizedCwd);
      }
    },
  );

  const browse: WorkspaceEntriesShape["browse"] = Effect.fn("WorkspaceEntries.browse")(
    function* (input) {
      const resolvedInputPath = yield* resolveBrowseTarget(input, path);
      const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath === "~";
      const parentPath = endsWithSeparator ? resolvedInputPath : path.dirname(resolvedInputPath);
      const prefix = endsWithSeparator ? "" : path.basename(resolvedInputPath);

      const dirents = yield* Effect.tryPromise({
        try: () => fsPromises.readdir(parentPath, { withFileTypes: true }),
        catch: (cause) =>
          new WorkspaceEntriesBrowseError({
            cwd: input.cwd,
            partialPath: input.partialPath,
            operation: "workspaceEntries.browse.readDirectory",
            detail: `Unable to browse '${parentPath}': ${processErrorDetail(cause)}`,
            cause,
          }),
      });

      const showHidden = endsWithSeparator || prefix.startsWith(".");
      const lowerPrefix = prefix.toLowerCase();

      return {
        parentPath,
        entries: dirents
          .filter(
            (dirent) =>
              dirent.isDirectory() &&
              dirent.name.toLowerCase().startsWith(lowerPrefix) &&
              (showHidden || !dirent.name.startsWith(".")),
          )
          .map((dirent) => ({
            name: dirent.name,
            fullPath: path.join(parentPath, dirent.name),
          }))
          .toSorted((left, right) => left.name.localeCompare(right.name)),
      };
    },
  );

  const matchFileContents = Effect.fn("WorkspaceEntries.matchFileContents")(function* (
    cwd: string,
    relativePath: string,
    matcher: (contents: string) => boolean,
  ): Effect.fn.Return<boolean, never> {
    return yield* Effect.promise(async () => {
      try {
        const absolutePath = path.join(cwd, relativePath);
        const stat = await fsPromises.stat(absolutePath);
        if (!stat.isFile() || stat.size > WORKSPACE_CONTENT_SEARCH_MAX_FILE_BYTES) {
          return false;
        }
        const contents = await fsPromises.readFile(absolutePath, "utf8");
        if (contents.includes("\u0000")) {
          return false;
        }
        return matcher(contents);
      } catch {
        return false;
      }
    });
  });

  const searchByPathRegex = (
    index: WorkspaceIndex,
    regex: RegExp,
    limit: number,
  ): {
    entries: ProjectEntry[];
    truncated: boolean;
  } => {
    const sortedEntries = [...index.entries].toSorted((left, right) =>
      left.path.localeCompare(right.path),
    );
    const matches: SearchableWorkspaceEntry[] = [];
    let matchedEntryCount = 0;

    for (const entry of sortedEntries) {
      if (!resetAndTestRegex(regex, entry.path)) {
        continue;
      }
      matchedEntryCount += 1;
      if (matches.length < limit) {
        matches.push(entry);
      }
    }

    return {
      entries: matches.map(toPublicProjectEntry),
      truncated: index.truncated || matchedEntryCount > limit,
    };
  };

  const searchByFuzzyPath = (
    index: WorkspaceIndex,
    normalizedQuery: string,
    limit: number,
  ): {
    entries: ProjectEntry[];
    truncated: boolean;
  } => {
    const rankedEntries: RankedWorkspaceEntry[] = [];
    let matchedEntryCount = 0;

    for (const entry of index.entries) {
      const score = scoreEntry(entry, normalizedQuery);
      if (score === null) {
        continue;
      }
      matchedEntryCount += 1;
      insertRankedEntry(rankedEntries, { entry, score }, limit);
    }

    return {
      entries: rankedEntries.map((candidate) => toPublicProjectEntry(candidate.entry)),
      truncated: index.truncated || matchedEntryCount > limit,
    };
  };

  const searchByFileContents = Effect.fn("WorkspaceEntries.searchByFileContents")(function* ({
    cwd,
    index,
    limit,
    matcher,
  }: {
    cwd: string;
    index: WorkspaceIndex;
    limit: number;
    matcher: (contents: string) => boolean;
  }) {
    const fileEntries = [...index.entries]
      .filter((entry) => entry.kind === "file")
      .toSorted((left, right) => left.path.localeCompare(right.path));
    const candidateEntries = fileEntries.slice(0, WORKSPACE_CONTENT_SEARCH_MAX_FILES);
    const truncatedByCandidateLimit = fileEntries.length > candidateEntries.length;

    const matchedEntries: SearchableWorkspaceEntry[] = [];
    let matchedEntryCount = 0;

    for (
      let startIndex = 0;
      startIndex < candidateEntries.length && matchedEntryCount <= limit;
      startIndex += WORKSPACE_CONTENT_SEARCH_READ_CONCURRENCY
    ) {
      const batchEntries = candidateEntries.slice(
        startIndex,
        startIndex + WORKSPACE_CONTENT_SEARCH_READ_CONCURRENCY,
      );
      const batchMatches = yield* Effect.forEach(
        batchEntries,
        (entry) => matchFileContents(cwd, entry.path, matcher),
        { concurrency: "unbounded" },
      );

      for (const [indexInBatch, matched] of batchMatches.entries()) {
        if (!matched) {
          continue;
        }
        const matchedEntry = batchEntries[indexInBatch];
        if (!matchedEntry) {
          continue;
        }
        matchedEntryCount += 1;
        if (matchedEntries.length < limit) {
          matchedEntries.push(matchedEntry);
        }
      }
    }

    return {
      entries: matchedEntries.map(toPublicProjectEntry),
      truncated: index.truncated || truncatedByCandidateLimit || matchedEntryCount > limit,
    };
  });

  const search: WorkspaceEntriesShape["search"] = Effect.fn("WorkspaceEntries.search")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      const index = yield* Cache.get(workspaceIndexCache, normalizedCwd);
      const limit = Math.max(0, Math.floor(input.limit));
      const searchQuery = parseWorkspaceSearchQuery(input.query);

      if (searchQuery.kind === "invalid" || limit <= 0) {
        return {
          entries: [],
          truncated: false,
        };
      }

      if (searchQuery.kind === "path-regex") {
        return searchByPathRegex(index, searchQuery.regex, limit);
      }

      if (searchQuery.kind === "content-substring") {
        return yield* searchByFileContents({
          cwd: normalizedCwd,
          index,
          limit,
          matcher: (contents) => contents.toLowerCase().includes(searchQuery.query),
        });
      }

      if (searchQuery.kind === "content-regex") {
        return yield* searchByFileContents({
          cwd: normalizedCwd,
          index,
          limit,
          matcher: (contents) => resetAndTestRegex(searchQuery.regex, contents),
        });
      }

      return searchByFuzzyPath(index, searchQuery.query, limit);
    },
  );

  const listTree: WorkspaceEntriesShape["listTree"] = Effect.fn("WorkspaceEntries.listTree")(
    function* (cwd) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(cwd);
      return yield* Cache.get(workspaceIndexCache, normalizedCwd).pipe(
        Effect.map((index) => ({
          entries: index.entries.map(toPublicProjectEntry),
          truncated: index.truncated,
        })),
      );
    },
  );

  return {
    browse,
    invalidate,
    listTree,
    search,
  } satisfies WorkspaceEntriesShape;
});

export const WorkspaceEntriesLive = Layer.effect(WorkspaceEntries, makeWorkspaceEntries);
