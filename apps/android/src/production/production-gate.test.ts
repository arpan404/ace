import { describe, expect, it } from "vitest";
import {
  PRODUCTION_FAILURE_COPY,
  initialPhaseOneState,
  shouldStartGatedLoad,
} from "./production-gate.ts";

describe("production lock gate", () => {
  it("never starts the directory load while locked", () => {
    expect(
      shouldStartGatedLoad({ hasStartup: true, locked: true, loaded: false, loading: false }),
    ).toBe(false);
  });

  it("starts the directory load only once unlocked", () => {
    expect(
      shouldStartGatedLoad({ hasStartup: true, locked: false, loaded: false, loading: false }),
    ).toBe(true);
  });

  it("stays gated without startup and never double-starts", () => {
    expect(
      shouldStartGatedLoad({ hasStartup: false, locked: false, loaded: false, loading: false }),
    ).toBe(false);
    expect(
      shouldStartGatedLoad({ hasStartup: true, locked: false, loaded: true, loading: false }),
    ).toBe(false);
    expect(
      shouldStartGatedLoad({ hasStartup: true, locked: false, loaded: false, loading: true }),
    ).toBe(false);
  });
});

describe("production failure and retry paths", () => {
  it("fails closed with copy that never touches paired content", () => {
    expect(PRODUCTION_FAILURE_COPY.missingBridge).toMatch(/cannot pair/i);
    expect(PRODUCTION_FAILURE_COPY.insecureWindow).toMatch(/cannot protect/i);
    expect(PRODUCTION_FAILURE_COPY.startup).toMatch(/could not start/i);
  });

  it("resets the secure-guard banner per phase-one generation", () => {
    // A retry must not inherit the previous generation's guarded banner:
    // the reset the root applies on every `startupAttempt` clears it.
    expect(initialPhaseOneState()).toEqual({
      loaded: false,
      loadError: null,
      secureGuardFailed: false,
    });
  });

  it("resets the gated-load verdict per phase-one generation", () => {
    const reset = initialPhaseOneState();
    // After the reset the unlock gate can start exactly one load.
    expect(
      shouldStartGatedLoad({
        hasStartup: true,
        locked: false,
        loaded: reset.loaded,
        loading: true,
      }),
    ).toBe(false);
    expect(
      shouldStartGatedLoad({
        hasStartup: true,
        locked: false,
        loaded: reset.loaded,
        loading: false,
      }),
    ).toBe(true);
  });
});
