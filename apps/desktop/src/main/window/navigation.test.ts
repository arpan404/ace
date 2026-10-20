import { describe, expect, it } from "vitest";
import { navigationDecision } from "./navigation.ts";

const appUrl = "app://ace/";

describe("app window navigation", () => {
  it("stays on the app's own pages", () => {
    expect(navigationDecision("app://ace/t/123", appUrl)).toBe("allow");
    expect(navigationDecision("app://ace/new", appUrl)).toBe("allow");
  });

  it("lets the page's own blob URLs proceed to the download handler", () => {
    // An attachment download is a top-level navigation to a blob: URL first; dropping it
    // here means will-download never fires and Download does nothing.
    expect(navigationDecision("blob:app://ace/9d1a", appUrl)).toBe("allow");
    expect(navigationDecision("blob:null/9d1a", appUrl)).toBe("allow");
    expect(navigationDecision("blob:http://localhost:5173/9d1a", appUrl)).toBe("allow");
  });

  it("opens web links outside and drops everything else", () => {
    expect(navigationDecision("https://example.com/thread", appUrl)).toBe("external");
    expect(navigationDecision("http://example.com/", appUrl)).toBe("external");
    expect(navigationDecision("data:text/html,<b>x</b>", appUrl)).toBe("deny");
    expect(navigationDecision("file:///etc/passwd", appUrl)).toBe("deny");
    expect(navigationDecision("::not a url::", appUrl)).toBe("deny");
  });

  it("follows the dev server while it serves the page", () => {
    expect(navigationDecision("http://localhost:5173/t/123", "http://localhost:5173/")).toBe(
      "allow",
    );
  });
});
