import { describe, expect, it } from "vitest";

import {
  addPinnedBrowserPage,
  isPinnedBrowserPage,
  parsePinnedBrowserPages,
  removePinnedBrowserPage,
  serializePinnedBrowserPages,
  togglePinnedBrowserPage,
} from "./pinnedPages";

describe("browser pinned pages", () => {
  it("adds pinned pages newest first", () => {
    const pages = addPinnedBrowserPage([], {
      pinnedAt: 10,
      title: "Docs",
      url: "https://example.com/docs",
    });

    expect(pages).toEqual([
      {
        pinnedAt: 10,
        title: "Docs",
        url: "https://example.com/docs",
      },
    ]);
  });

  it("removes and toggles pinned pages by url", () => {
    const initialPages = [
      {
        pinnedAt: 10,
        title: "Docs",
        url: "https://example.com/docs",
      },
    ];

    expect(isPinnedBrowserPage(initialPages, "https://example.com/docs")).toBe(true);
    expect(removePinnedBrowserPage(initialPages, "https://example.com/docs")).toEqual([]);
    expect(
      togglePinnedBrowserPage(initialPages, {
        pinnedAt: 30,
        title: "Docs",
        url: "https://example.com/docs",
      }),
    ).toEqual([]);
  });

  it("serializes and parses pinned pages", () => {
    const raw = serializePinnedBrowserPages([
      {
        pinnedAt: 20,
        title: "Docs",
        url: "https://example.com/docs",
      },
      {
        pinnedAt: 10,
        title: "Home",
        url: "https://example.com/",
      },
    ]);

    expect(parsePinnedBrowserPages(raw)).toEqual([
      {
        pinnedAt: 20,
        title: "Docs",
        url: "https://example.com/docs",
      },
      {
        pinnedAt: 10,
        title: "Home",
        url: "https://example.com/",
      },
    ]);
  });
});
