import { describe, expect, it } from "vitest";

import { buildBrowserSuggestions, recordBrowserHistory } from "./history";

describe("browser history", () => {
  it("deduplicates entries by url, keeps latest first, and tracks visit counts", () => {
    const history = recordBrowserHistory(
      [
        { title: "Old", url: "https://example.com/", visitedAt: 10, visitCount: 1 },
        { title: "Docs", url: "https://docs.example.com/", visitedAt: 20, visitCount: 3 },
      ],
      { title: "New", url: "https://example.com/", visitedAt: 30, visitCount: 1 },
    );

    expect(history).toEqual([
      { title: "New", url: "https://example.com/", visitedAt: 30, visitCount: 2 },
      { title: "Docs", url: "https://docs.example.com/", visitedAt: 20, visitCount: 3 },
    ]);
  });

  it("builds a search suggestion and matching history suggestions", () => {
    const suggestions = buildBrowserSuggestions("google", {
      history: [
        {
          title: "Google Docs",
          url: "https://docs.google.com/",
          visitedAt: 20,
          visitCount: 2,
        },
        { title: "OpenAI", url: "https://openai.com/", visitedAt: 10, visitCount: 1 },
      ],
      searchEngine: "duckduckgo",
    });

    expect(suggestions).toContainEqual({
      id: "search:google",
      kind: "search",
      subtitle: "Search DuckDuckGo",
      title: "google",
      url: "https://duckduckgo.com/?q=google",
    });
    expect(suggestions).toContainEqual({
      id: "history:https://docs.google.com/",
      kind: "history",
      subtitle: "https://docs.google.com/",
      title: "Google Docs",
      url: "https://docs.google.com/",
    });
  });

  it("prioritizes matching open tabs over history duplicates", () => {
    const suggestions = buildBrowserSuggestions("docs", {
      activeTabId: "active",
      activePageUrl: "https://docs.example.com/guide",
      history: [
        {
          title: "Project Docs",
          url: "https://docs.example.com/",
          visitedAt: 100,
          visitCount: 1,
        },
      ],
      now: 1000,
      openTabs: [
        { id: "active", title: "Current", url: "https://current.example.com/" },
        { id: "docs-tab", title: "Project Docs", url: "https://docs.example.com/" },
      ],
      searchEngine: "duckduckgo",
    });

    expect(suggestions[0]).toMatchObject({
      id: "tab:docs-tab",
      kind: "tab",
      tabId: "docs-tab",
      title: "Project Docs",
      url: "https://docs.example.com/",
    });
    expect(suggestions.some((suggestion) => suggestion.kind === "history")).toBe(false);
  });

  it("includes pinned pages and boosts pages from the current site", () => {
    const suggestions = buildBrowserSuggestions("", {
      activePageUrl: "https://github.com/ace/ace",
      history: [
        {
          title: "Example Docs",
          url: "https://example.com/docs",
          visitedAt: 100,
          visitCount: 1,
        },
      ],
      now: 1000,
      pinnedPages: [
        {
          pinnedAt: 900,
          title: "GitHub Issues",
          url: "https://github.com/ace/ace/issues",
        },
      ],
      searchEngine: "duckduckgo",
    });

    expect(suggestions[0]).toMatchObject({
      kind: "pinned",
      title: "GitHub Issues",
      url: "https://github.com/ace/ace/issues",
    });
  });
});
