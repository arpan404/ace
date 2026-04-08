import { describe, expect, it } from "vitest";

import { resolveAppStartupMessage, resolveAppStartupState } from "./appStartup";

describe("resolveAppStartupState", () => {
  it("stays in connecting mode until the native api exists", () => {
    expect(
      resolveAppStartupState({
        bootstrapComplete: false,
        hasNativeApi: false,
      }),
    ).toBe("connecting");
  });

  it("stays in bootstrapping mode until bootstrap completes", () => {
    expect(
      resolveAppStartupState({
        bootstrapComplete: false,
        hasNativeApi: true,
      }),
    ).toBe("bootstrapping");
  });

  it("becomes ready once the native api exists and bootstrap is complete", () => {
    expect(
      resolveAppStartupState({
        bootstrapComplete: true,
        hasNativeApi: true,
      }),
    ).toBe("ready");
  });
});

describe("resolveAppStartupMessage", () => {
  it("returns user-facing messages for non-ready states", () => {
    expect(resolveAppStartupMessage("connecting", "ace")).toBe("Connecting to ace server...");
    expect(resolveAppStartupMessage("bootstrapping", "ace")).toBe("Loading ace...");
  });
});
