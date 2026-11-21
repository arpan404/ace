import { describe, expect, it, vi } from "vitest";
import {
  resolveSecureScreenEnabled,
  setSecureScreenEnabled,
  setSecureScreenEnabledAsync,
} from "./secureScreen.ts";
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

  it("never claims success for an async native result synchronously", () => {
    // The outcome is not yet known: fail-closed keeps the guarded banner
    // until the async helper settles, instead of reporting success that a
    // later rejection would contradict.
    const setSecureScreen = vi.fn().mockRejectedValue(new Error("gone"));
    expect(setSecureScreenEnabled(true, () => ({ setSecureScreen }))).toBe(false);
  });

  it("async helper reports rejection as failure, never success", async () => {
    const setSecureScreen = vi.fn().mockRejectedValue(new Error("gone"));
    await expect(setSecureScreenEnabledAsync(true, () => ({ setSecureScreen }))).resolves.toBe(
      false,
    );
  });

  it("async helper reports async success only when it settles applied", async () => {
    const ok = vi.fn().mockResolvedValue(undefined);
    await expect(setSecureScreenEnabledAsync(true, () => ({ setSecureScreen: ok }))).resolves.toBe(
      true,
    );
    const denied = vi.fn().mockResolvedValue(false);
    await expect(
      setSecureScreenEnabledAsync(true, () => ({ setSecureScreen: denied })),
    ).resolves.toBe(false);
  });

  it("treats then-only thenables as async, never sync success", () => {
    const thenOnly = {
      // eslint-disable-next-line unicorn/no-thenable
      then(onFulfilled: (value: unknown) => void) {
        onFulfilled(undefined);
      },
    };
    expect(setSecureScreenEnabled(true, () => ({ setSecureScreen: () => thenOnly }))).toBe(false);
  });

  it("async helper awaits then-only thenables", async () => {
    const thenOnly = {
      // eslint-disable-next-line unicorn/no-thenable
      then(onFulfilled: (value: unknown) => void) {
        onFulfilled(undefined);
      },
    };
    await expect(
      setSecureScreenEnabledAsync(true, () => ({ setSecureScreen: () => thenOnly })),
    ).resolves.toBe(true);
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
