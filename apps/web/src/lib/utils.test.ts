import { DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM } from "@ace/contracts";
import { afterEach, assert, describe, expect, it, vi } from "vitest";

import { isWindowsPlatform, resolveServerUrl } from "./utils";

const originalWindow = globalThis.window;

function setWindowForTest(input?: {
  readonly search?: string;
  readonly desktopBridge?: { getWsUrl?: () => string | null };
}) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        origin: "http://localhost:3020",
        search: input?.search ?? "",
      },
      desktopBridge: input?.desktopBridge,
    },
  });
}

describe("isWindowsPlatform", () => {
  it("matches Windows platform identifiers", () => {
    assert.isTrue(isWindowsPlatform("Win32"));
    assert.isTrue(isWindowsPlatform("Windows"));
    assert.isTrue(isWindowsPlatform("windows_nt"));
  });

  it("does not match darwin", () => {
    assert.isFalse(isWindowsPlatform("darwin"));
  });
});

describe("resolveServerUrl", () => {
  afterEach(() => {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
    vi.restoreAllMocks();
  });

  it("uses the desktop bootstrap ws url query param when present", () => {
    const backendWsUrl = "ws://127.0.0.1:52426/?token=secret-token";

    setWindowForTest({
      search: `?${DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM}=${encodeURIComponent(backendWsUrl)}`,
    });

    expect(resolveServerUrl({ protocol: "ws", pathname: "/ws" })).toBe(
      "ws://127.0.0.1:52426/ws?token=secret-token",
    );
  });

  it("prefers the bootstrap query param before touching the desktop bridge", () => {
    const backendWsUrl = "ws://127.0.0.1:52426/?token=secret-token";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const getWsUrl = vi.fn(() => {
      throw new Error("desktop bridge unavailable");
    });

    setWindowForTest({
      search: `?${DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM}=${encodeURIComponent(backendWsUrl)}`,
      desktopBridge: {
        getWsUrl,
      },
    });

    expect(resolveServerUrl({ protocol: "ws", pathname: "/ws" })).toBe(
      "ws://127.0.0.1:52426/ws?token=secret-token",
    );
    expect(getWsUrl).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("uses the desktop bridge url when no bootstrap query param is present", () => {
    setWindowForTest({
      desktopBridge: {
        getWsUrl: () => "ws://127.0.0.1:52426/?token=secret-token",
      },
    });

    expect(resolveServerUrl({ protocol: "ws", pathname: "/ws" })).toBe(
      "ws://127.0.0.1:52426/ws?token=secret-token",
    );
  });
});
