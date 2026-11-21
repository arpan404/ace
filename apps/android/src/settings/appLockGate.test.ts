import { describe, expect, it } from "vitest";
import {
  isStaleUnlockAttempt,
  resolveInitialLocked,
  resolveUnlockAfterAuth,
  shouldShowLockCover,
  shouldShowPrivacyCover,
  shouldStartRuntime,
  unlockFailureText,
} from "./appLock.ts";
import { nonLockPatch, resolveSettingsAfterSave, DEFAULT_SETTINGS } from "./store.ts";

describe("fail-closed app lock startup", () => {
  it("stays locked while settings have not loaded yet", () => {
    expect(resolveInitialLocked(null, false)).toBe(true);
  });

  it("stays locked when the settings storage failed", () => {
    expect(resolveInitialLocked(null, true)).toBe(true);
    expect(resolveInitialLocked({ lockEnabled: false }, true)).toBe(true);
  });

  it("adopts the stored lock choice once settings load", () => {
    expect(resolveInitialLocked({ lockEnabled: true }, false)).toBe(true);
    expect(resolveInitialLocked({ lockEnabled: false }, false)).toBe(false);
  });

  it("never connects before settings load or when storage failed", () => {
    expect(
      shouldStartRuntime({
        settingsLoaded: false,
        storageFailed: false,
        locked: false,
        lockEnabled: false,
      }),
    ).toBe(false);
    expect(
      shouldStartRuntime({
        settingsLoaded: true,
        storageFailed: true,
        locked: false,
        lockEnabled: false,
      }),
    ).toBe(false);
  });

  it("never connects while the lock holds", () => {
    expect(
      shouldStartRuntime({
        settingsLoaded: true,
        storageFailed: false,
        locked: true,
        lockEnabled: true,
      }),
    ).toBe(false);
  });

  it("connects once unlocked, or when the lock is off", () => {
    expect(
      shouldStartRuntime({
        settingsLoaded: true,
        storageFailed: false,
        locked: false,
        lockEnabled: true,
      }),
    ).toBe(true);
    expect(
      shouldStartRuntime({
        settingsLoaded: true,
        storageFailed: false,
        locked: false,
        lockEnabled: false,
      }),
    ).toBe(true);
  });
});

describe("lock and privacy covers", () => {
  it("covers the screen only when the lock is on and holding", () => {
    expect(shouldShowLockCover({ locked: true, lockEnabled: true })).toBe(true);
    expect(shouldShowLockCover({ locked: false, lockEnabled: true })).toBe(false);
    expect(shouldShowLockCover({ locked: true, lockEnabled: false })).toBe(false);
  });

  it("covers backgrounded content while the lock is on, even unlocked", () => {
    for (const appState of ["background", "inactive", "unknown", "extension"]) {
      expect(shouldShowPrivacyCover({ locked: false, lockEnabled: true, appState }), appState).toBe(
        true,
      );
    }
  });

  it("leaves the active screen alone and never double-covers the lock", () => {
    expect(shouldShowPrivacyCover({ locked: false, lockEnabled: true, appState: "active" })).toBe(
      false,
    );
    expect(
      shouldShowPrivacyCover({ locked: false, lockEnabled: false, appState: "background" }),
    ).toBe(false);
    expect(
      shouldShowPrivacyCover({ locked: true, lockEnabled: true, appState: "background" }),
    ).toBe(false);
  });
});

describe("fail-closed settings migration", () => {
  it("never migrates the lock choice or timeout from the fallback", () => {
    expect(nonLockPatch({ appearance: "dark", returnSends: true, lockEnabled: false })).toEqual({
      appearance: "dark",
      returnSends: true,
    });
    expect(nonLockPatch({ lockEnabled: true, lockTimeoutSeconds: 0 })).toEqual({});
    expect(nonLockPatch({})).toEqual({});
  });

  it("keeps migrating interface preferences alone", () => {
    expect(nonLockPatch({ appearance: "light" })).toEqual({ appearance: "light" });
    expect(nonLockPatch({ returnSends: false })).toEqual({ returnSends: false });
  });
});

describe("unlock attempts", () => {
  it("opens on success and clears the failure", () => {
    expect(resolveUnlockAfterAuth("success")).toEqual({ unlocked: true, failed: false });
    expect(unlockFailureText(false)).toBe(null);
  });

  it("opens when no device credential exists, like iOS", () => {
    expect(resolveUnlockAfterAuth("unavailable")).toEqual({ unlocked: true, failed: false });
  });

  it("stays locked with a visible failure after a failed check", () => {
    expect(resolveUnlockAfterAuth("failed")).toEqual({ unlocked: false, failed: true });
    expect(unlockFailureText(true)).toBe("Couldn't verify it's you.");
  });
});

describe("lock-episode reentry", () => {
  it("accepts the current episode's device check", () => {
    expect(isStaleUnlockAttempt({ attemptGeneration: 2, currentGeneration: 2 })).toBe(false);
  });

  it("rejects a stale success answered after a relock", () => {
    expect(isStaleUnlockAttempt({ attemptGeneration: 2, currentGeneration: 3 })).toBe(true);
    expect(isStaleUnlockAttempt({ attemptGeneration: 0, currentGeneration: 1 })).toBe(true);
  });
});

describe("durable lock saves", () => {
  it("commits the toggle only when the write succeeds", () => {
    const enabled = { ...DEFAULT_SETTINGS, lockEnabled: true };
    expect(
      resolveSettingsAfterSave({
        previous: DEFAULT_SETTINGS,
        next: enabled,
        saveSucceeded: true,
      }),
    ).toEqual(enabled);
  });

  it("keeps the previous state when the write fails, so a restart cannot come back unlocked", () => {
    const claimed = { ...DEFAULT_SETTINGS, lockEnabled: true };
    const committed = resolveSettingsAfterSave({
      previous: DEFAULT_SETTINGS,
      next: claimed,
      saveSucceeded: false,
    });
    expect(committed).toEqual(DEFAULT_SETTINGS);
    expect(committed.lockEnabled).toBe(false);
  });

  it("rolls back timeout changes the same way", () => {
    const claimed = { ...DEFAULT_SETTINGS, lockTimeoutSeconds: 300 };
    expect(
      resolveSettingsAfterSave({ previous: DEFAULT_SETTINGS, next: claimed, saveSucceeded: false }),
    ).toEqual(DEFAULT_SETTINGS);
  });
});
