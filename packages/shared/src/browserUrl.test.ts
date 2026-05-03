import { describe, expect, it } from "vitest";
import {
  DEFAULT_BROWSER_HOME_URL,
  normalizeBrowserInput,
  resolveBrowserHomeUrl,
  resolveBrowserInputTarget,
} from "./browserUrl";

describe("browserUrl", () => {
  it("resolves empty input to the selected search engine home page", () => {
    expect(DEFAULT_BROWSER_HOME_URL).toBe("https://duckduckgo.com/");
    expect(resolveBrowserHomeUrl("google")).toBe("https://www.google.com/");
    expect(normalizeBrowserInput("", "brave")).toBe("https://search.brave.com/");
  });

  it("normalizes URLs and localhost targets", () => {
    expect(normalizeBrowserInput("example.com")).toBe("https://example.com/");
    expect(normalizeBrowserInput("localhost:3000/test")).toBe("http://localhost:3000/test");
    expect(normalizeBrowserInput("http://example.com/test")).toBe("http://example.com/test");
  });

  it("searches with the selected engine for non-url input", () => {
    expect(normalizeBrowserInput("playwright locator docs", "google")).toBe(
      "https://www.google.com/search?q=playwright%20locator%20docs",
    );
    expect(normalizeBrowserInput("playwright locator docs", "startpage")).toBe(
      "https://www.startpage.com/sp/search?query=playwright%20locator%20docs",
    );
  });

  it("returns the resolved intent for browser input", () => {
    expect(resolveBrowserInputTarget("example.com", "duckduckgo")).toEqual({
      intent: "navigate",
      url: "https://example.com/",
    });
    expect(resolveBrowserInputTarget("search term", "duckduckgo")).toEqual({
      intent: "search",
      url: "https://duckduckgo.com/?q=search%20term",
    });
  });
});
