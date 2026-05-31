import type { ProjectEntry } from "@ace/contracts";

import { basenameOfPath } from "~/vscode-icons";

const WORKSPACE_CODE_SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "be",
  "by",
  "can",
  "code",
  "could",
  "file",
  "find",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "possibly",
  "search",
  "sitting",
  "the",
  "this",
  "to",
  "where",
  "with",
]);

const MAX_CODE_SEARCH_TERMS = 5;
const MAX_CODE_SEARCH_SNIPPETS = 3;

export interface WorkspaceCodeSearchSnippet {
  readonly lineNumber: number;
  readonly text: string;
}

export interface WorkspaceCodeSearchResult {
  readonly entry: ProjectEntry;
  readonly matchCount: number;
  readonly score: number;
  readonly snippets: readonly WorkspaceCodeSearchSnippet[];
}

export type WorkspaceCodeSearchGroupId = "likely" | "content" | "path";

export interface WorkspaceCodeSearchResultGroup {
  readonly id: WorkspaceCodeSearchGroupId;
  readonly label: string;
  readonly results: readonly WorkspaceCodeSearchResult[];
}

export interface WorkspaceCodeSearchTextPart {
  readonly highlight: boolean;
  readonly text: string;
}

function uniqueValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

export function extractWorkspaceCodeSearchTerms(query: string): readonly string[] {
  const searchableQuery = query.replace(/\b(?:content|in|inre|re):/giu, " ");
  const rawTerms = searchableQuery
    .toLowerCase()
    .match(/[a-z0-9_$.-]{2,}/gu)
    ?.map((term) => term.replace(/^[._-]+|[._-]+$/gu, ""))
    .filter((term) => term.length >= 2 && !WORKSPACE_CODE_SEARCH_STOP_WORDS.has(term));

  return uniqueValues(rawTerms ?? []).slice(0, MAX_CODE_SEARCH_TERMS);
}

export function buildWorkspaceCodeSearchQueries(query: string): readonly string[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const hasExplicitSearchPrefix = /^(?:content|in|inre|re):/iu.test(trimmed);
  const queries = [trimmed];
  const terms = extractWorkspaceCodeSearchTerms(trimmed);
  if (
    !hasExplicitSearchPrefix &&
    terms.length > 1 &&
    trimmed.length <= 96 &&
    !trimmed.includes("\n")
  ) {
    queries.push(`content:${trimmed}`);
  }
  for (const term of terms) {
    queries.push(`content:${term}`);
  }
  return uniqueValues(queries);
}

function countOccurrences(value: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }

  let count = 0;
  let index = value.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = value.indexOf(needle, index + needle.length);
  }
  return count;
}

function trimSnippetLine(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= 220) {
    return trimmed;
  }
  return `${trimmed.slice(0, 217).trimEnd()}...`;
}

export function createWorkspaceCodeSearchResult(input: {
  readonly contents: string;
  readonly entry: ProjectEntry;
  readonly query: string;
}): WorkspaceCodeSearchResult | null {
  const terms = extractWorkspaceCodeSearchTerms(input.query);
  if (terms.length === 0) {
    return null;
  }

  const normalizedPath = input.entry.path.toLowerCase();
  const normalizedName = basenameOfPath(input.entry.path).toLowerCase();
  const lines = input.contents.split(/\r?\n/u);
  const snippets: WorkspaceCodeSearchSnippet[] = [];
  let matchCount = 0;
  let score = 0;

  for (const term of terms) {
    if (normalizedName.includes(term)) {
      score += 60;
    } else if (normalizedPath.includes(term)) {
      score += 30;
    }
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const normalizedLine = line.toLowerCase();
    let lineMatches = 0;
    for (const term of terms) {
      lineMatches += countOccurrences(normalizedLine, term);
    }

    if (lineMatches === 0) {
      continue;
    }

    matchCount += lineMatches;
    score += Math.min(80, lineMatches * 12) + Math.max(0, 20 - Math.min(20, lineIndex / 25));
    if (snippets.length < MAX_CODE_SEARCH_SNIPPETS) {
      snippets.push({
        lineNumber: lineIndex + 1,
        text: trimSnippetLine(line),
      });
    }
  }

  if (matchCount === 0 && score === 0) {
    return null;
  }

  return {
    entry: input.entry,
    matchCount,
    score,
    snippets,
  };
}

export function sortWorkspaceCodeSearchResults(
  results: readonly WorkspaceCodeSearchResult[],
): readonly WorkspaceCodeSearchResult[] {
  return results.toSorted(
    (left, right) => right.score - left.score || left.entry.path.localeCompare(right.entry.path),
  );
}

export function groupWorkspaceCodeSearchResults(
  results: readonly WorkspaceCodeSearchResult[],
): readonly WorkspaceCodeSearchResultGroup[] {
  const likely: WorkspaceCodeSearchResult[] = [];
  const content: WorkspaceCodeSearchResult[] = [];
  const path: WorkspaceCodeSearchResult[] = [];

  for (const result of results) {
    if (result.score >= 90 || result.matchCount >= 3) {
      likely.push(result);
    } else if (result.snippets.length > 0) {
      content.push(result);
    } else {
      path.push(result);
    }
  }

  const groups: WorkspaceCodeSearchResultGroup[] = [
    { id: "likely", label: "Likely files", results: likely },
    { id: "content", label: "Content matches", results: content },
    { id: "path", label: "Path matches", results: path },
  ];
  return groups.filter((group) => group.results.length > 0);
}

export function highlightWorkspaceCodeSearchText(
  text: string,
  query: string,
): readonly WorkspaceCodeSearchTextPart[] {
  const terms = extractWorkspaceCodeSearchTerms(query)
    .filter((term) => term.length > 0)
    .toSorted((left, right) => right.length - left.length);
  if (terms.length === 0 || text.length === 0) {
    return [{ highlight: false, text }];
  }

  const normalizedText = text.toLowerCase();
  const parts: WorkspaceCodeSearchTextPart[] = [];
  let index = 0;
  while (index < text.length) {
    const match = terms
      .map((term) => ({ term, index: normalizedText.indexOf(term, index) }))
      .filter((candidate) => candidate.index >= 0)
      .toSorted((left, right) => left.index - right.index || right.term.length - left.term.length)
      .at(0);
    if (!match) {
      parts.push({ highlight: false, text: text.slice(index) });
      break;
    }
    if (match.index > index) {
      parts.push({ highlight: false, text: text.slice(index, match.index) });
    }
    parts.push({
      highlight: true,
      text: text.slice(match.index, match.index + match.term.length),
    });
    index = match.index + match.term.length;
  }

  return parts;
}
