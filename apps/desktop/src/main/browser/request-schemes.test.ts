import { describe, expect, it } from "vitest";
import { pdfViewerOrigin, requestKind } from "./request-schemes.ts";

describe("what a native page may request", () => {
  it("lets Chromium's PDF viewer load its own frame and resources, so a PDF shows in the tab", () => {
    expect(requestKind(`${pdfViewerOrigin}/index.html`)).toBe("viewer");
    expect(requestKind("chrome://resources/js/load_time_data.js")).toBe("viewer");
  });

  it("refuses every other extension and internal page", () => {
    for (const url of [
      "chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/popup.html",
      "chrome://settings/",
      "file:///etc/passwd",
      "javascript:alert(1)",
    ])
      expect(requestKind(url)).toBe("refused");
  });

  it("sends web pages to the daemon's approval and refuses credentials in the address", () => {
    expect(requestKind("https://example.com/doc.pdf")).toBe("fetched");
    expect(requestKind("https://user:secret@example.com/")).toBe("refused");
    expect(requestKind("wss://example.com/socket")).toBe("socket");
    expect(requestKind("data:image/png;base64,AAAA")).toBe("passive");
  });
});
