import { describe, expect, it } from "vitest";

import {
  DEFAULT_BROWSER_HOME_URL,
  normalizeBrowserInput,
  normalizeBrowserHttpUrl,
  resolveBrowserDisplayUrl,
  resolveBrowserHomeUrl,
  resolveBrowserInputTarget,
  resolveBrowserRelayUrl,
} from "./url";

describe("browser url", () => {
  it("falls back to the browser home page for empty input", () => {
    expect(normalizeBrowserInput("")).toBe(DEFAULT_BROWSER_HOME_URL);
  });

  it("adds https for domains", () => {
    expect(normalizeBrowserInput("example.com")).toBe("https://example.com/");
  });

  it("treats bare words as search queries", () => {
    expect(normalizeBrowserInput("google")).toBe("https://duckduckgo.com/?q=google");
  });

  it("keeps explicit http URLs intact", () => {
    expect(normalizeBrowserInput("http://example.com/test")).toBe("http://example.com/test");
  });

  it("uses localhost with http", () => {
    expect(normalizeBrowserInput("localhost:3000/test")).toBe("http://localhost:3000/test");
  });

  it("searches multi-word input", () => {
    expect(normalizeBrowserInput("playwright locator docs")).toBe(
      "https://duckduckgo.com/?q=playwright%20locator%20docs",
    );
  });

  it("uses the configured search engine for search queries", () => {
    expect(normalizeBrowserInput("playwright locator docs", "google")).toBe(
      "https://www.google.com/search?q=playwright%20locator%20docs",
    );
  });

  it("returns the configured search engine home page", () => {
    expect(resolveBrowserHomeUrl("startpage")).toBe("https://www.startpage.com/");
    expect(DEFAULT_BROWSER_HOME_URL).toBe("https://duckduckgo.com/");
  });

  it("classifies address-bar intent", () => {
    expect(resolveBrowserInputTarget("", "duckduckgo")).toEqual({
      intent: "home",
      url: "https://duckduckgo.com/",
    });
    expect(resolveBrowserInputTarget("google", "duckduckgo")).toEqual({
      intent: "search",
      url: "https://duckduckgo.com/?q=google",
    });
    expect(resolveBrowserInputTarget("example.com", "duckduckgo")).toEqual({
      intent: "navigate",
      url: "https://example.com/",
    });
  });

  it("normalizes only http and https URLs for webview navigation", () => {
    expect(normalizeBrowserHttpUrl(" https://example.com/docs ")).toBe("https://example.com/docs");
    expect(normalizeBrowserHttpUrl("chrome-error://chromewebdata/")).toBeNull();
    expect(normalizeBrowserHttpUrl("about:blank")).toBeNull();
  });

  it("relays browser URLs through the project owner connection", () => {
    expect(
      resolveBrowserRelayUrl({
        url: "https://example.com/app",
        ownerConnectionUrl: "ws://remote.example:8080/ws?token=abc",
        localConnectionUrl: "ws://127.0.0.1:8080/ws",
      }),
    ).toBe(
      "http://remote.example:8080/api/browser-relay?url=https%3A%2F%2Fexample.com%2Fapp&token=abc",
    );
  });

  it("does not relay browser URLs when the project owner is local", () => {
    expect(
      resolveBrowserRelayUrl({
        url: "https://example.com/app",
        ownerConnectionUrl: "ws://127.0.0.1:8080/ws",
        localConnectionUrl: "ws://127.0.0.1:8080/ws",
      }),
    ).toBe("https://example.com/app");
  });

  it("restores the displayed URL for relayed browser navigations", () => {
    expect(
      resolveBrowserDisplayUrl(
        "http://remote.example:8080/api/browser-relay?url=http%3A%2F%2Flocalhost%3A3000%2Fapp",
      ),
    ).toBe("http://localhost:3000/app");
  });
});
