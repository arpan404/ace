import { DESKTOP_BOOTSTRAP_DEV_BUILD_QUERY_PARAM } from "@ace/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalWindow = globalThis.window;

function setWindow(value: unknown): void {
  Object.defineProperty(globalThis, "window", {
    value,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  vi.resetModules();
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
    return;
  }

  setWindow(originalWindow);
});

describe("IS_DEV_BUILD", () => {
  it("treats the desktop bootstrap dev-build query flag as development", async () => {
    setWindow({
      location: {
        search: `?${DESKTOP_BOOTSTRAP_DEV_BUILD_QUERY_PARAM}=1`,
      },
      desktopBridge: {
        getIsDevelopmentBuild: () => false,
      },
    });

    const branding = await import("./branding");
    expect(branding.IS_DEV_BUILD).toBe(true);
  });

  it("falls back to desktop bridge development detection", async () => {
    setWindow({
      location: {
        search: "",
      },
      desktopBridge: {
        getIsDevelopmentBuild: () => true,
      },
    });

    const branding = await import("./branding");
    expect(branding.IS_DEV_BUILD).toBe(true);
  });
});
