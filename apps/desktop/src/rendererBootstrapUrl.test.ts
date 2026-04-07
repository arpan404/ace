import { DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM } from "@ace/contracts";
import { describe, expect, it } from "vitest";

import { appendDesktopBootstrapWsUrl } from "./rendererBootstrapUrl";

describe("appendDesktopBootstrapWsUrl", () => {
  it("injects the backend websocket url into packaged desktop renderer urls", () => {
    const backendWsUrl = "ws://127.0.0.1:52426/?token=secret-token";

    expect(appendDesktopBootstrapWsUrl("ace://app/index.html", backendWsUrl)).toBe(
      `ace://app/index.html?${DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM}=${encodeURIComponent(
        backendWsUrl,
      )}`,
    );
  });

  it("preserves existing renderer query params", () => {
    const backendWsUrl = "ws://127.0.0.1:52426/?token=secret-token";
    const resolvedUrl = appendDesktopBootstrapWsUrl(
      "http://localhost:5733/?loadDebug=1",
      backendWsUrl,
    );

    const parsedUrl = new URL(resolvedUrl);

    expect(parsedUrl.searchParams.get("loadDebug")).toBe("1");
    expect(parsedUrl.searchParams.get(DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM)).toBe(backendWsUrl);
  });
});
