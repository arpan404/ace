import { DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM } from "@ace/contracts";
import { afterEach, assert, describe, expect, it, vi } from "vitest";

import {
  clearBootstrapWsUrlQueryParam,
  clearActiveWsUrlOverride,
  isWindowsPlatform,
  persistActiveWsUrlOverride,
  resolveServerUrl,
} from "./utils";

const originalWindow = globalThis.window;

function setWindowForTest(input?: {
  readonly search?: string;
  readonly desktopBridge?: { getWsUrl?: () => string | null };
}) {
  const sessionStorageState = new Map<string, string>();
  const locationSearch = input?.search ?? "";
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        origin: "http://localhost:3020",
        href: `http://localhost:3020/${locationSearch}`,
        pathname: "/",
        hash: "",
        search: locationSearch,
      },
      history: {
        state: null,
        replaceState: (_state: unknown, _unused: string, url: string) => {
          const parsed = new URL(url, "http://localhost:3020");
          window.location.search = parsed.search;
          window.location.pathname = parsed.pathname;
          window.location.hash = parsed.hash;
          window.location.href = parsed.toString();
        },
      },
      sessionStorage: {
        getItem: (key: string) => sessionStorageState.get(key) ?? null,
        setItem: (key: string, value: string) => {
          sessionStorageState.set(key, value);
        },
        removeItem: (key: string) => {
          sessionStorageState.delete(key);
        },
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

  it("keeps the local origin as the default even when a bootstrap ws query param is present", () => {
    setWindowForTest({
      search: `?${DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM}=${encodeURIComponent("ws://127.0.0.1:52426/?token=secret-token")}`,
    });

    expect(resolveServerUrl({ protocol: "ws", pathname: "/ws" })).toBe("ws://localhost:3020/ws");
  });

  it("prefers desktop bridge before bootstrap query fallback", () => {
    const backendWsUrl = "ws://127.0.0.1:52426/?token=secret-token";
    const getWsUrl = vi.fn(() => "ws://127.0.0.1:3025/?token=local-token");

    setWindowForTest({
      search: `?${DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM}=${encodeURIComponent(backendWsUrl)}`,
      desktopBridge: {
        getWsUrl,
      },
    });

    expect(resolveServerUrl({ protocol: "ws", pathname: "/ws" })).toBe(
      "ws://127.0.0.1:3025/ws?token=local-token",
    );
    expect(getWsUrl).toHaveBeenCalledTimes(1);
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

  it("prefers an active ws override over the desktop bridge url", () => {
    setWindowForTest({
      desktopBridge: {
        getWsUrl: () => "ws://127.0.0.1:3025/?token=local-token",
      },
    });
    persistActiveWsUrlOverride("ws://10.0.0.25:3773/ws?token=remote");

    expect(resolveServerUrl({ protocol: "ws", pathname: "/ws" })).toBe(
      "ws://10.0.0.25:3773/ws?token=remote",
    );
    clearActiveWsUrlOverride();
  });
});

describe("clearBootstrapWsUrlQueryParam", () => {
  it("strips bootstrap ws query parameter without touching other params", () => {
    setWindowForTest({
      search: `?${DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM}=${encodeURIComponent("ws://127.0.0.1:52426/ws")}&mode=settings`,
    });

    clearBootstrapWsUrlQueryParam();

    expect(window.location.search).toBe("?mode=settings");
  });
});
