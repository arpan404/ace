import type { ProjectEntry } from "@ace/contracts";

import { basenameOfPath } from "~/vscode-icons";

export const MIN_WORKSPACE_REMOTE_SEARCH_QUERY_LENGTH = 2;

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

function compileWorkspacePathRegex(query: string): RegExp | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    return new RegExp(trimmed, "i");
  } catch {
    return null;
  }
}

export function shouldRunWorkspaceRemoteSearch(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length < MIN_WORKSPACE_REMOTE_SEARCH_QUERY_LENGTH) {
    return false;
  }
  return !trimmed.toLowerCase().startsWith("re:");
}

export function searchWorkspaceEntriesLocally(
  entries: readonly ProjectEntry[],
  query: string,
): readonly ProjectEntry[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return entries;
  }

  const lowerTrimmed = trimmed.toLowerCase();
  if (lowerTrimmed.startsWith("re:")) {
    const regex = compileWorkspacePathRegex(trimmed.slice(3));
    if (!regex) {
      return [];
    }
    return entries.filter((entry) => regex.test(entry.path));
  }

  const normalizedQuery = lowerTrimmed.replace(/^[@./]+/, "");
  if (normalizedQuery.length === 0) {
    return entries;
  }

  return entries
    .map((entry) => {
      const normalizedPath = entry.path.toLowerCase();
      const normalizedName = basenameOfPath(entry.path).toLowerCase();
      let score: number | null = null;

      if (normalizedName === normalizedQuery) score = 0;
      else if (normalizedPath === normalizedQuery) score = 1;
      else if (normalizedName.startsWith(normalizedQuery)) score = 2;
      else if (normalizedPath.startsWith(normalizedQuery)) score = 3;
      else if (normalizedPath.includes(`/${normalizedQuery}`)) score = 4;
      else if (normalizedName.includes(normalizedQuery)) score = 5;
      else if (normalizedPath.includes(normalizedQuery)) score = 6;
      else {
        const fuzzyNameScore = scoreSubsequenceMatch(normalizedName, normalizedQuery);
        if (fuzzyNameScore !== null) {
          score = 100 + fuzzyNameScore;
        } else {
          const fuzzyPathScore = scoreSubsequenceMatch(normalizedPath, normalizedQuery);
          if (fuzzyPathScore !== null) {
            score = 200 + fuzzyPathScore;
          }
        }
      }

      return score === null ? null : { entry, score };
    })
    .filter((value): value is { entry: ProjectEntry; score: number } => value !== null)
    .toSorted(
      (left, right) => left.score - right.score || left.entry.path.localeCompare(right.entry.path),
    )
    .map((value) => value.entry);
}

export function mergeWorkspaceSearchEntries(
  localEntries: readonly ProjectEntry[],
  remoteEntries: readonly ProjectEntry[],
  limit = Number.POSITIVE_INFINITY,
): readonly ProjectEntry[] {
  const merged: ProjectEntry[] = [];
  const seenPaths = new Set<string>();

  const appendEntries = (entries: readonly ProjectEntry[]) => {
    for (const entry of entries) {
      if (merged.length >= limit || seenPaths.has(entry.path)) {
        continue;
      }
      seenPaths.add(entry.path);
      merged.push(entry);
    }
  };

  appendEntries(localEntries);
  appendEntries(remoteEntries);

  return merged;
}
