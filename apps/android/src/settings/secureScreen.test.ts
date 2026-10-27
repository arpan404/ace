import { describe, expect, it, vi } from "vitest";
import { resolveSecureScreenEnabled, setSecureScreenEnabled } from "./secureScreen.ts";
describe("secure screen guard", () => {
  it("stays secure until the durable lock choice is known", () => {
    expect(
      resolveSecureScreenEnabled({
        lockEnabled: false,
        settingsLoaded: false,
        storageFailed: false,
      }),
    ).toBe(true);
  });

  it("stays secure when storage failed", () => {
    expect(
      resolveSecureScreenEnabled({
        lockEnabled: false,
        settingsLoaded: true,
        storageFailed: true,
      }),
    ).toBe(true);
  });

  it("follows the durable lock choice once settings load", () => {
    expect(
      resolveSecureScreenEnabled({
        lockEnabled: true,
        settingsLoaded: true,
        storageFailed: false,
      }),
    ).toBe(true);
    expect(
      resolveSecureScreenEnabled({
        lockEnabled: false,
        settingsLoaded: true,
        storageFailed: false,
      }),
    ).toBe(false);
  });
});

describe("secure screen bridge", () => {
  it("never throws without the native module", () => {
    expect(
      setSecureScreenEnabled(true, () => {
        throw new Error("no bridge");
      }),
    ).toBe(false);
    expect(setSecureScreenEnabled(false)).toBe(false);
  });

  it("attempts the native call when the bridge exists", () => {
    const setSecureScreen = vi.fn();
    expect(setSecureScreenEnabled(true, () => ({ setSecureScreen }))).toBe(true);
    expect(setSecureScreen).toHaveBeenCalledWith(true);
  });

  it("swallows async native rejections", () => {
    const setSecureScreen = vi.fn().mockRejectedValue(new Error("gone"));
    expect(setSecureScreenEnabled(true, () => ({ setSecureScreen }))).toBe(true);
  });

  it("reports failure when native has no activity to apply to", () => {
    expect(setSecureScreenEnabled(true, () => ({ setSecureScreen: () => false }))).toBe(false);
  });

  it("treats an explicit native true as applied", () => {
    const setSecureScreen = vi.fn().mockReturnValue(true);
    expect(setSecureScreenEnabled(false, () => ({ setSecureScreen }))).toBe(true);
    expect(setSecureScreen).toHaveBeenCalledWith(false);
  });
});
