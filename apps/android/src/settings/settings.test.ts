import { describe, expect, it } from "vitest";
import {
  appearanceLabel,
  labelForStoredAppearance,
  parseAppearanceMode,
  parseReturnSends,
  resolveAppearanceScheme,
} from "./appearance.ts";
import {
  APP_LOCK_TIMEOUTS,
  enableOnFirstPairing,
  initialLockEnabled,
  isSupportedLockTimeout,
  requiresAuthToDisable,
  resolveDisableAfterAuth,
  resolveStoredLockTimeout,
  shouldRelockOnActive,
} from "./appLock.ts";
import {
  collectDiagnosticsReport,
  parseDiagnosticsAccessKind,
  renderDiagnosticsJson,
} from "./diagnostics.ts";
import { toAuthOutcome } from "./deviceAuth.ts";

describe("appearance settings", () => {
  it("accepts the three known modes", () => {
    expect(parseAppearanceMode("system")).toBe("system");
    expect(parseAppearanceMode("light")).toBe("light");
    expect(parseAppearanceMode("dark")).toBe("dark");
  });

  it("falls back to system for unknown, mistyped, or missing values", () => {
    for (const value of [
      "System",
      "DARK",
      "custom",
      "",
      null,
      undefined,
      0,
      true,
      { mode: "dark" },
      ["light"],
    ]) {
      expect(parseAppearanceMode(value), JSON.stringify(value)).toBe("system");
      expect(labelForStoredAppearance(value), JSON.stringify(value)).toBe("System");
    }
  });

  it("labels each stored mode like iOS Settings", () => {
    expect(appearanceLabel("system")).toBe("System");
    expect(appearanceLabel("light")).toBe("Light");
    expect(appearanceLabel("dark")).toBe("Dark");
  });

  it("resolves system mode through the OS scheme", () => {
    expect(resolveAppearanceScheme("system", "light")).toBe("light");
    expect(resolveAppearanceScheme("system", "dark")).toBe("dark");
    expect(resolveAppearanceScheme("light", "dark")).toBe("light");
    expect(resolveAppearanceScheme("dark", "light")).toBe("dark");
  });

  it("enables Send with Return only for an explicit true", () => {
    expect(parseReturnSends(true)).toBe(true);
    for (const value of ["true", 1, null, undefined, 0, {}]) {
      expect(parseReturnSends(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe("app lock rules", () => {
  it("offers exactly the iOS timeout set", () => {
    expect([...APP_LOCK_TIMEOUTS]).toEqual([0, 60, 300, 900, 3600]);
  });

  it("rejects timeouts outside the offer list", () => {
    expect(isSupportedLockTimeout(42)).toBe(false);
    expect(isSupportedLockTimeout("60")).toBe(false);
    expect(isSupportedLockTimeout(Number.NaN)).toBe(false);
    expect(isSupportedLockTimeout(undefined)).toBe(false);
    expect(isSupportedLockTimeout(60)).toBe(true);
  });

  it("keeps the fallback when the stored timeout is unsupported", () => {
    expect(resolveStoredLockTimeout(300, 60)).toBe(300);
    expect(resolveStoredLockTimeout(42, 60)).toBe(60);
    expect(resolveStoredLockTimeout("300", 60)).toBe(60);
    expect(resolveStoredLockTimeout(undefined, 60)).toBe(60);
  });

  it("prefers the stored lock choice over the paired default", () => {
    expect(initialLockEnabled(false, true)).toBe(false);
    expect(initialLockEnabled(true, false)).toBe(true);
    expect(initialLockEnabled(undefined, true)).toBe(true);
    expect(initialLockEnabled(undefined, false)).toBe(false);
  });

  it("enables the lock on first pairing unless the person chose", () => {
    expect(enableOnFirstPairing(undefined)).toBe(true);
    expect(enableOnFirstPairing(null)).toBe(true);
    expect(enableOnFirstPairing(false)).toBe(false);
    expect(enableOnFirstPairing(true)).toBe(true);
  });

  it("requires the device owner to turn the lock off", () => {
    expect(requiresAuthToDisable(true, false)).toBe(true);
    expect(requiresAuthToDisable(true, true)).toBe(false);
    expect(requiresAuthToDisable(false, false)).toBe(false);
    expect(requiresAuthToDisable(false, true)).toBe(false);
  });

  it("keeps the lock when disabling authentication fails", () => {
    expect(resolveDisableAfterAuth(true, "failed")).toBe(true);
    expect(resolveDisableAfterAuth(true, "success")).toBe(false);
    expect(resolveDisableAfterAuth(true, "unavailable")).toBe(false);
  });

  it("maps device authentication to the iOS outcomes", () => {
    expect(toAuthOutcome(true, true)).toBe("success");
    expect(toAuthOutcome(false, true)).toBe("failed");
    expect(toAuthOutcome(true, false)).toBe("unavailable");
    expect(toAuthOutcome(false, false)).toBe("unavailable");
  });

  it("relocks after the chosen background timeout, not before", () => {
    const base = {
      enabled: true,
      locked: false,
      backgroundedAtMs: 1_000,
      timeoutSeconds: 60,
    };
    expect(shouldRelockOnActive({ ...base, nowMs: 1_000 + 59_000 })).toBe(false);
    expect(shouldRelockOnActive({ ...base, nowMs: 1_000 + 60_000 })).toBe(true);
  });

  it("relocks at once with a zero timeout", () => {
    expect(
      shouldRelockOnActive({
        enabled: true,
        locked: false,
        backgroundedAtMs: 5_000,
        nowMs: 5_001,
        timeoutSeconds: 0,
      }),
    ).toBe(true);
  });

  it("never relocks while disabled, already locked, or never backgrounded", () => {
    const active = {
      backgroundedAtMs: 0,
      nowMs: 3_600_000,
      timeoutSeconds: 60,
    };
    expect(shouldRelockOnActive({ ...active, enabled: false, locked: false })).toBe(false);
    expect(shouldRelockOnActive({ ...active, enabled: true, locked: true })).toBe(false);
    expect(
      shouldRelockOnActive({
        enabled: true,
        locked: false,
        backgroundedAtMs: null,
        nowMs: 3_600_000,
        timeoutSeconds: 60,
      }),
    ).toBe(false);
  });
});

describe("diagnostics export", () => {
  it("carries state as codes and counts", () => {
    const report = collectDiagnosticsReport({
      generatedAt: "1970-01-01T00:00:00Z",
      app: { version: "1.0", build: "7", system: "Android", device: "device" },
      machines: [
        {
          name: "studio",
          hostId: "host-1",
          accessKind: "lan",
          connection: "offline",
          problem: "unreachable",
          status: "working",
          aceVersion: "0.0.1",
          viewOnly: false,
          threads: 12,
          unsent: 2,
          tools: { codex: "ready" },
        },
      ],
      notifications: { enabled: true, permission: "allowed", mutedMachines: 1 },
      lock: { enabled: true, timeoutSeconds: 60 },
    });
    const json = renderDiagnosticsJson(report);
    expect(json).toContain('"connection": "offline"');
    expect(json).toContain('"accessKind": "lan"');
    expect(json).toContain('"threads": 12');
    expect(json).toContain('"unsent": 2');
    expect(json).toContain('"mutedMachines": 1');
    expect(json).toContain('"timeoutSeconds": 60');
  });

  it("has no field for addresses, pins, device ids, tokens, or text", () => {
    const report = collectDiagnosticsReport({
      generatedAt: "1970-01-01T00:00:00Z",
      app: { version: "1.0", build: "7", system: "Android", device: "device" },
      machines: [
        {
          name: "studio",
          hostId: "host-1",
          connection: "offline",
          viewOnly: true,
          threads: 0,
          unsent: 0,
          tools: {},
        },
      ],
    });
    const json = renderDiagnosticsJson(report);
    for (const secret of [
      "device-secret-id",
      "192.168.1.20",
      "PINPINPIN",
      "wss://",
      "ace-token",
      "thread title",
    ]) {
      expect(json, secret).not.toContain(secret);
    }
    const machine = report.machines[0];
    if (machine === undefined) throw new Error("expected one machine");
    expect("url" in machine).toBe(false);
    expect("fingerprint" in machine).toBe(false);
    expect("deviceId" in machine).toBe(false);
  });

  it("keeps only the known pairing kinds", () => {
    expect(parseDiagnosticsAccessKind("lan")).toBe("lan");
    expect(parseDiagnosticsAccessKind("tailscale")).toBe("tailscale");
    expect(parseDiagnosticsAccessKind("wss://192.168.1.20:9443")).toBe(undefined);
    expect(parseDiagnosticsAccessKind(undefined)).toBe(undefined);
  });

  it("renders deterministic sorted keys", () => {
    const args = {
      generatedAt: "1970-01-01T00:00:00Z",
      app: { version: "1.0", build: "7", system: "Android", device: "device" },
      machines: [] as never[],
    };
    expect(renderDiagnosticsJson(collectDiagnosticsReport(args))).toBe(
      renderDiagnosticsJson(collectDiagnosticsReport(args)),
    );
  });
});
