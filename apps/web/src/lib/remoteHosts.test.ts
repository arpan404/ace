import { afterEach, describe, expect, it } from "vitest";

import { clearActiveWsUrlOverride, persistActiveWsUrlOverride } from "./utils";
import { resolveLocalDeviceWsUrl } from "./remoteHosts";

const originalWindow = globalThis.window;

function setWindowForTest(input?: { readonly desktopBridge?: { getWsUrl?: () => string | null } }) {
  const sessionStorageState = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        origin: "http://localhost:3020",
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

describe("resolveLocalDeviceWsUrl", () => {
  afterEach(() => {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });

  it("returns the desktop bridge ws url even when active ws override is remote", () => {
    setWindowForTest({
      desktopBridge: {
        getWsUrl: () => "ws://127.0.0.1:3025/?token=local-token",
      },
    });
    persistActiveWsUrlOverride("ws://10.0.0.25:3773/ws?token=remote");

    expect(resolveLocalDeviceWsUrl()).toBe("ws://127.0.0.1:3025/ws?token=local-token");

    clearActiveWsUrlOverride();
  });

  it("falls back to local browser-origin ws url when desktop bridge is unavailable", () => {
    setWindowForTest();
    persistActiveWsUrlOverride("ws://10.0.0.25:3773/ws?token=remote");

    expect(resolveLocalDeviceWsUrl()).toBe("ws://localhost:3020/ws");

    clearActiveWsUrlOverride();
  });
});
