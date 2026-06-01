import { describe, expect, it } from "vitest";

import { resolveBrowserSessionUserAgent } from "./browserUserAgent";

describe("browserUserAgent", () => {
  it("removes Electron and app tokens from the in-app browser user agent", () => {
    expect(
      resolveBrowserSessionUserAgent(
        "Mozilla/5.0 AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36 Electron/41.5.0 ace/0.2.3",
      ),
    ).toBe("Mozilla/5.0 AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36");
  });

  it("keeps the original user agent when sanitization would empty it", () => {
    expect(resolveBrowserSessionUserAgent("Electron/41.5.0")).toBe("Electron/41.5.0");
  });
});
