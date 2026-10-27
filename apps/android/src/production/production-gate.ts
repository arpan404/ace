/**
 * Pure lifecycle gates for the production root.
 *
 * `ProductionRoot.tsx` owns the effects; this module owns the decisions so
 * the lock gate and the failure/retry paths are unit-testable without a
 * renderer (the unit project runs logic tests only). Every predicate fails
 * closed: unknown or missing state never starts a load and never clears a
 * failure.
 */

/** Fail-closed copy for the production root. Single source for root + tests. */
export const PRODUCTION_FAILURE_COPY = {
  missingBridge: "This build cannot pair yet: the pinned bridge is missing.",
  insecureWindow: "This build cannot protect the screen, so it stays closed.",
  startup: "The connection could not start.",
} as const;

export interface GatedLoadState {
  hasStartup: boolean;
  locked: boolean;
  loaded: boolean;
  loading: boolean;
}

/**
 * True only when the gated directory load may start: the startup object
 * exists, the app lock is open, and no load is complete or in flight. While
 * `locked` nothing is read or connected.
 */
export function shouldStartGatedLoad(state: GatedLoadState): boolean {
  if (!state.hasStartup) return false;
  if (state.locked) return false;
  if (state.loaded) return false;
  if (state.loading) return false;
  return true;
}

/** Fresh per-generation UI state for a phase-one attempt. */
export interface PhaseOneReset {
  loaded: false;
  loadError: null;
  secureGuardFailed: false;
}

/**
 * A new phase-one generation owns a fresh load: drop the previous
 * generation's gated-load verdict and the stale secure-guard banner so a
 * retry never inherits them.
 */
export function initialPhaseOneState(): PhaseOneReset {
  return { loaded: false, loadError: null, secureGuardFailed: false };
}
