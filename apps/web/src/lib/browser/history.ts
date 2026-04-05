import * as Schema from "effect/Schema";
import type { BrowserSearchEngine } from "@ace/contracts/settings";

import {
  normalizeBrowserInput,
  resolveBrowserHomeUrl,
  resolveBrowserInputTarget,
} from "~/lib/browser/url";
import type { BrowserPinnedPage } from "~/lib/browser/pinnedPages";
import type { BrowserTabState } from "~/lib/browser/session";

export const BROWSER_HISTORY_STORAGE_KEY = "ace:browser:history:v1";
export const MAX_BROWSER_HISTORY_ENTRIES = 200;
export const MAX_BROWSER_SUGGESTIONS = 8;

export const BrowserHistoryEntrySchema = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
  visitedAt: Schema.Number,
  visitCount: Schema.Number.pipe(Schema.withDecodingDefault(() => 1)),
});
export type BrowserHistoryEntry = typeof BrowserHistoryEntrySchema.Type;

export const BrowserHistorySchema = Schema.Array(BrowserHistoryEntrySchema);
export type BrowserHistory = typeof BrowserHistorySchema.Type;

export type BrowserSuggestion = {
  id: string;
  kind: "history" | "home" | "navigate" | "pinned" | "search" | "tab";
  subtitle: string;
  tabId?: string;
  title: string;
  url: string;
};

type RankedBrowserSuggestion = BrowserSuggestion & {
  dedupeKey: string;
  score: number;
};

const SUGGESTION_KIND_PRIORITY: Record<BrowserSuggestion["kind"], number> = {
  navigate: 0,
  tab: 1,
  pinned: 2,
  history: 3,
  search: 4,
  home: 5,
};

function normalizeSuggestionText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(?:www\.)?/i, "");
}

function resolveSuggestionHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function resolveSuggestionSiteKey(url: string): string {
  const hostname = resolveSuggestionHostname(url);
  if (hostname.length === 0) {
    return "";
  }

  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
  ) {
    return hostname;
  }

  const parts = hostname.split(".").filter(Boolean);
  if (parts.length <= 2) {
    return hostname;
  }

  return parts.slice(-2).join(".");
}

function scoreDomainAffinity(candidateUrl: string, activePageUrl?: string): number {
  if (!activePageUrl) {
    return 0;
  }

  const candidateSite = resolveSuggestionSiteKey(candidateUrl);
  const activeSite = resolveSuggestionSiteKey(activePageUrl);
  if (candidateSite.length === 0 || activeSite.length === 0 || candidateSite !== activeSite) {
    return 0;
  }

  return 58;
}

function scoreMatchField(field: string, query: string): number {
  if (field.length === 0 || query.length === 0) {
    return 0;
  }
  if (field === query) {
    return 240;
  }
  if (field.startsWith(query)) {
    return 160;
  }

  const matchIndex = field.indexOf(query);
  if (matchIndex === -1) {
    return 0;
  }

  const previousCharacter = field[matchIndex - 1] ?? "";
  return /[/:._\-\s]/.test(previousCharacter) ? 110 : 60;
}

function scoreSuggestionTextMatch(input: string, title: string, url: string): number {
  const query = normalizeSuggestionText(input);
  if (query.length === 0) {
    return 0;
  }

  const normalizedTitle = normalizeSuggestionText(title);
  const normalizedUrl = normalizeSuggestionText(url);
  const normalizedHostname = resolveSuggestionHostname(url);
  return Math.max(
    scoreMatchField(normalizedTitle, query),
    scoreMatchField(normalizedUrl, query),
    scoreMatchField(normalizedHostname, query),
  );
}

function scoreHistoryEntry(
  input: string,
  entry: BrowserHistoryEntry,
  now: number,
  activePageUrl?: string,
): number {
  const textScore = scoreSuggestionTextMatch(input, entry.title, entry.url);
  const visitScore = Math.min(Math.max(entry.visitCount, 1), 20) * 14;
  const ageHours = Math.max(0, now - entry.visitedAt) / (1000 * 60 * 60);
  const recencyScore = Math.max(0, 56 - ageHours / 4);
  return (
    textScore +
    visitScore +
    recencyScore +
    scoreDomainAffinity(entry.url, activePageUrl) +
    (input.trim().length === 0 ? 18 : 0)
  );
}

function scoreOpenTab(
  input: string,
  tab: Pick<BrowserTabState, "title" | "url">,
  activePageUrl?: string,
): number {
  return (
    scoreSuggestionTextMatch(input, tab.title, tab.url) +
    scoreDomainAffinity(tab.url, activePageUrl) +
    (input.trim().length === 0 ? 90 : 120)
  );
}

function scorePinnedPage(input: string, page: BrowserPinnedPage, activePageUrl?: string): number {
  return (
    scoreSuggestionTextMatch(input, page.title, page.url) +
    scoreDomainAffinity(page.url, activePageUrl) +
    150 +
    (input.trim().length === 0 ? 72 : 16)
  );
}

function sortRankedSuggestions(
  left: RankedBrowserSuggestion,
  right: RankedBrowserSuggestion,
): number {
  return (
    right.score - left.score ||
    SUGGESTION_KIND_PRIORITY[left.kind] - SUGGESTION_KIND_PRIORITY[right.kind] ||
    left.title.localeCompare(right.title)
  );
}

export function recordBrowserHistory(
  history: BrowserHistory,
  entry: BrowserHistoryEntry,
): BrowserHistory {
  if (entry.url.trim().length === 0) {
    return history;
  }

  const previousEntry = history.find((item) => item.url === entry.url);
  const nextEntry: BrowserHistoryEntry = {
    ...entry,
    title: entry.title.trim().length > 0 ? entry.title : (previousEntry?.title ?? entry.url),
    visitCount: Math.max(entry.visitCount, previousEntry?.visitCount ?? 0, 0) + 1,
  };
  const nextEntries = [nextEntry, ...history.filter((item) => item.url !== entry.url)];
  return nextEntries
    .filter((item) => Number.isFinite(item.visitedAt))
    .toSorted((left, right) => right.visitedAt - left.visitedAt)
    .slice(0, MAX_BROWSER_HISTORY_ENTRIES);
}

function resolveSearchEngineLabel(searchEngine: BrowserSearchEngine): string {
  switch (searchEngine) {
    case "google":
      return "Google";
    case "brave":
      return "Brave Search";
    case "startpage":
      return "Startpage";
    case "duckduckgo":
    default:
      return "DuckDuckGo";
  }
}

export function buildBrowserSuggestions(
  input: string,
  options: {
    activeTabId?: string;
    activePageUrl?: string;
    history: BrowserHistory;
    now?: number;
    openTabs?: readonly Pick<BrowserTabState, "id" | "title" | "url">[];
    pinnedPages?: readonly BrowserPinnedPage[];
    searchEngine: BrowserSearchEngine;
  },
): BrowserSuggestion[] {
  const trimmedInput = input.trim();
  const normalizedInput = normalizeSuggestionText(trimmedInput);
  const rankedSuggestions: RankedBrowserSuggestion[] = [];
  const now = options.now ?? Date.now();

  if (trimmedInput.length > 0) {
    const target = resolveBrowserInputTarget(trimmedInput, options.searchEngine);
    const searchUrl = normalizeBrowserInput(trimmedInput, options.searchEngine);
    const searchEngineLabel = resolveSearchEngineLabel(options.searchEngine);

    rankedSuggestions.push({
      dedupeKey: `search:${trimmedInput}`,
      id: `search:${trimmedInput}`,
      kind: "search",
      score: 170,
      subtitle: `Search ${searchEngineLabel}`,
      title: trimmedInput,
      url: searchUrl,
    });

    if (target.intent === "navigate") {
      rankedSuggestions.push({
        dedupeKey: target.url,
        id: `navigate:${target.url}`,
        kind: "navigate",
        score: 220 + scoreSuggestionTextMatch(trimmedInput, target.url, target.url),
        subtitle: "Open address",
        title: target.url,
        url: target.url,
      });
    }
  } else {
    rankedSuggestions.push({
      dedupeKey: `home:${options.searchEngine}`,
      id: `home:${options.searchEngine}`,
      kind: "home",
      score: 180,
      subtitle: "Open home page",
      title: resolveSearchEngineLabel(options.searchEngine),
      url: resolveBrowserHomeUrl(options.searchEngine),
    });
  }

  for (const tab of options.openTabs ?? []) {
    if (tab.id === options.activeTabId) {
      continue;
    }
    if (
      normalizedInput.length > 0 &&
      scoreSuggestionTextMatch(trimmedInput, tab.title, tab.url) === 0
    ) {
      continue;
    }
    rankedSuggestions.push({
      dedupeKey: tab.url,
      id: `tab:${tab.id}`,
      kind: "tab",
      score: scoreOpenTab(trimmedInput, tab, options.activePageUrl),
      subtitle: "Switch to open tab",
      tabId: tab.id,
      title: tab.title,
      url: tab.url,
    });
  }

  for (const page of options.pinnedPages ?? []) {
    if (
      normalizedInput.length > 0 &&
      scoreSuggestionTextMatch(trimmedInput, page.title, page.url) === 0
    ) {
      continue;
    }
    rankedSuggestions.push({
      dedupeKey: page.url,
      id: `pinned:${page.url}`,
      kind: "pinned",
      score: scorePinnedPage(trimmedInput, page, options.activePageUrl),
      subtitle: "Pinned page",
      title: page.title,
      url: page.url,
    });
  }

  for (const entry of options.history) {
    if (
      normalizedInput.length > 0 &&
      scoreSuggestionTextMatch(trimmedInput, entry.title, entry.url) === 0
    ) {
      continue;
    }
    rankedSuggestions.push({
      dedupeKey: entry.url,
      id: `history:${entry.url}`,
      kind: "history",
      score: scoreHistoryEntry(trimmedInput, entry, now, options.activePageUrl),
      subtitle: entry.url,
      title: entry.title,
      url: entry.url,
    });
  }

  const seenKeys = new Set<string>();
  const suggestions: BrowserSuggestion[] = [];
  for (const suggestion of rankedSuggestions.toSorted(sortRankedSuggestions)) {
    if (seenKeys.has(suggestion.dedupeKey)) {
      continue;
    }
    seenKeys.add(suggestion.dedupeKey);
    const { dedupeKey: _dedupeKey, score: _score, ...nextSuggestion } = suggestion;
    suggestions.push(nextSuggestion);
    if (suggestions.length >= MAX_BROWSER_SUGGESTIONS) {
      break;
    }
  }

  return suggestions;
}
