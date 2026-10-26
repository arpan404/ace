import { describe, expect, it } from "vitest";
import { mobileAgent, phoneSized } from "./mobile-agent.ts";

describe("a phone viewer's page is served as to a phone", () => {
  it("headless Chrome passes as Chrome on Android, with no headless marker", () => {
    const agent = mobileAgent("HeadlessChrome/153.0.8010.12");
    expect(agent?.userAgent).toBe(
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36",
    );
    expect(agent?.userAgentMetadata).toMatchObject({ mobile: true, platform: "Android" });
  });

  it("the desktop app's engine drops its own app tokens", () => {
    const agent = mobileAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ace/1.4.0 Chrome/140.0.7339.41 Electron/38.1.0 Safari/537.36",
    );
    expect(agent?.userAgent).not.toMatch(/Electron|ace\/|Macintosh/);
    expect(agent?.userAgent).toContain("Chrome/140.0.0.0 Mobile Safari");
  });

  it("an engine string without a Chrome version gives no user agent", () => {
    expect(mobileAgent("Firefox/140.0")).toBeUndefined();
  });

  it("a phone stays a phone when it turns sideways; a tablet is not one", () => {
    expect(phoneSized(390, 760)).toBe(true);
    expect(phoneSized(932, 430)).toBe(true);
    expect(phoneSized(820, 1180)).toBe(false);
  });
});
