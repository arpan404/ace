import { describe, expect, it } from "vitest";

import { detectElectronEnvironment } from "./env";

describe("detectElectronEnvironment", () => {
  it("detects Electron when the desktop bridge is present", () => {
    expect(
      detectElectronEnvironment({
        desktopBridge: {},
        location: { protocol: "http:" },
        navigator: { userAgent: "Mozilla/5.0" },
      }),
    ).toBe(true);
  });

  it("detects packaged desktop builds by the ace protocol", () => {
    expect(
      detectElectronEnvironment({
        location: { protocol: "ace:" },
        navigator: { userAgent: "Mozilla/5.0" },
      }),
    ).toBe(true);
  });

  it("detects Electron dev builds by user agent", () => {
    expect(
      detectElectronEnvironment({
        location: { protocol: "http:" },
        navigator: { userAgent: "Mozilla/5.0 Electron/40.6.0" },
      }),
    ).toBe(true);
  });

  it("does not report Electron for regular browsers", () => {
    expect(
      detectElectronEnvironment({
        location: { protocol: "https:" },
        navigator: { userAgent: "Mozilla/5.0 Safari/537.36" },
      }),
    ).toBe(false);
  });

  it("does not report Electron without an environment", () => {
    expect(detectElectronEnvironment(null)).toBe(false);
  });
});
