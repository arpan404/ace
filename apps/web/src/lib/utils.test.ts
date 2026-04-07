import { DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM } from "@ace/contracts";
import { afterEach, assert, describe, expect, it, vi } from "vitest";

import { isWindowsPlatform, resolveServerUrl } from "./utils";

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
    window.history.replaceState({}, "", "/");
    Reflect.deleteProperty(window, "desktopBridge");
    vi.restoreAllMocks();
  });

  it("uses the desktop bootstrap ws url query param when present", () => {
    const backendWsUrl = "ws://127.0.0.1:52426/?token=secret-token";

    window.history.replaceState(
      {},
      "",
      `/?${DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM}=${encodeURIComponent(backendWsUrl)}`,
    );

    expect(resolveServerUrl({ protocol: "ws", pathname: "/ws" })).toBe(
      "ws://127.0.0.1:52426/ws?token=secret-token",
    );
  });

  it("falls back to the bootstrap query param when reading the desktop bridge throws", () => {
    const backendWsUrl = "ws://127.0.0.1:52426/?token=secret-token";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    window.history.replaceState(
      {},
      "",
      `/?${DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM}=${encodeURIComponent(backendWsUrl)}`,
    );
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: {
        getWsUrl: () => {
          throw new Error("desktop bridge unavailable");
        },
      },
    });

    expect(resolveServerUrl({ protocol: "ws", pathname: "/ws" })).toBe(
      "ws://127.0.0.1:52426/ws?token=secret-token",
    );
    expect(warn).toHaveBeenCalledOnce();
  });

  it("uses the desktop bridge url when no bootstrap query param is present", () => {
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: {
        getWsUrl: () => "ws://127.0.0.1:52426/?token=secret-token",
      },
    });

    expect(resolveServerUrl({ protocol: "ws", pathname: "/ws" })).toBe(
      "ws://127.0.0.1:52426/ws?token=secret-token",
    );
  });
});
