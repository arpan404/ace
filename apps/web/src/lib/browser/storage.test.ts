import { describe, expect, it } from "vitest";

import {
  IN_APP_BROWSER_PARTITION,
  resolveBrowserWebviewPartition,
  resolveScopedBrowserStorageKey,
} from "./storage";

describe("browser storage", () => {
  it("scopes storage keys with encoded browser scope ids", () => {
    expect(resolveScopedBrowserStorageKey("ace:browser:session:v2", "thread:browser:right")).toBe(
      "ace:browser:session:v2:thread%3Abrowser%3Aright",
    );
  });

  it("scopes Electron webview partitions by browser scope", () => {
    expect(resolveBrowserWebviewPartition("thread:browser:right")).toBe(
      `${IN_APP_BROWSER_PARTITION}:thread%3Abrowser%3Aright`,
    );
  });

  it("trims scope ids before resolving webview partitions", () => {
    expect(resolveBrowserWebviewPartition("  thread:browser:bottom  ")).toBe(
      `${IN_APP_BROWSER_PARTITION}:thread%3Abrowser%3Abottom`,
    );
  });

  it("keeps the legacy partition only for explicitly unscoped callers", () => {
    expect(resolveBrowserWebviewPartition(null)).toBe(IN_APP_BROWSER_PARTITION);
  });
});
