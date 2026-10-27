/**
 * Phone-local app-lock rules, ported from iOS `AppLock` (`Sources/Models/AppLock.swift`).
 *
 * Pure decision helpers only: no clock, storage, or biometric API access.
 * Callers inject `nowMs` / stored values and perform persistence and
 * authentication themselves. Timeouts are in seconds, matching the iOS
 * `Settings › App lock` offer list; `0` relocks as soon as ace leaves
 * the screen.
 */

export const APP_LOCK_TIMEOUTS: ReadonlyArray<number> = [0, 60, 300, 900, 3600];

export const APP_LOCK_ENABLED_KEY = "ace.lock.enabled";
export const APP_LOCK_TIMEOUT_KEY = "ace.lock.timeout";

export type AuthOutcome = "success" | "failed" | "unavailable";

export function isSupportedLockTimeout(value: unknown): value is number {
  return typeof value === "number" && APP_LOCK_TIMEOUTS.includes(value);
}

/**
 * Resolve the effective timeout from a stored value. Unsupported or missing
 * values fall back to `fallbackSeconds` (iOS default 60), never to the
 * nearest supported value, so an unknown stored number cannot silently
 * shorten or lengthen the lock window.
 */
export function resolveStoredLockTimeout(stored: unknown, fallbackSeconds: number): number {
  return isSupportedLockTimeout(stored) ? stored : fallbackSeconds;
}

/** A stored explicit choice wins over the paired-or-not default. */
export function initialLockEnabled(stored: unknown, defaultEnabled: boolean): boolean {
  return typeof stored === "boolean" ? stored : defaultEnabled;
}

/**
 * The first pairing turns the lock on, unless the person already chose.
 * Returns the enabled state after `enable()`: `true` only when no stored
 * choice exists.
 */
export function enableOnFirstPairing(storedEnabled: unknown): boolean {
  return storedEnabled === undefined || storedEnabled === null
    ? true
    : initialLockEnabled(storedEnabled, true);
}

/** Turning the lock off requires the device owner to authenticate. */
export function requiresAuthToDisable(currentlyEnabled: boolean, turningOn: boolean): boolean {
  return currentlyEnabled && !turningOn;
}

/**
 * Resolve the enabled state of a disable attempt after authentication.
 * `failed` keeps the current state; `success` and `unavailable` (no
 * passcode on the device, so nothing to unlock with) disable the lock.
 */
export function resolveDisableAfterAuth(currentlyEnabled: boolean, outcome: AuthOutcome): boolean {
  if (outcome === "failed") return currentlyEnabled;
  return false;
}

/**
 * Whether the app should relock when returning to the foreground.
 * Mirrors `AppLock.didBecomeActive()`: only when enabled, currently
 * unlocked, and the background stay reached the chosen timeout.
 */
export function shouldRelockOnActive(args: {
  enabled: boolean;
  locked: boolean;
  backgroundedAtMs: number | null;
  nowMs: number;
  timeoutSeconds: number;
}): boolean {
  if (!args.enabled || args.locked || args.backgroundedAtMs === null) {
    return false;
  }
  return args.nowMs - args.backgroundedAtMs >= args.timeoutSeconds * 1000;
}

/**
 * Fail-closed startup lock, mirroring iOS `AppLock.init` (`locked = on` from
 * the first synchronous read): while settings have not loaded, or when their
 * storage failed, the app stays locked. An unknown state can never render
 * unlocked.
 */
export function resolveInitialLocked(
  settings: { lockEnabled: boolean } | null,
  storageFailed: boolean,
): boolean {
  if (storageFailed) return true;
  if (settings === null) return true;
  return settings.lockEnabled;
}

/**
 * Whether the runtime may connect, mirroring iOS `RootView.task(id:
 * lock.locked)` which loads nothing until the person unlocks. Connecting
 * while the lock holds would fetch private threads behind the cover.
 */
export function shouldStartRuntime(args: {
  settingsLoaded: boolean;
  storageFailed: boolean;
  locked: boolean;
  lockEnabled: boolean;
}): boolean {
  if (!args.settingsLoaded || args.storageFailed) return false;
  return !(args.locked && args.lockEnabled);
}

/** Full-screen lock gate, shown only when the lock is on and holding. */
export function shouldShowLockCover(args: { locked: boolean; lockEnabled: boolean }): boolean {
  return args.locked && args.lockEnabled;
}

/**
 * Resolve an unlock attempt, mirroring iOS `AppLock.unlock()`: `success` and
 * `unavailable` (no device credential, so nothing to unlock with) open the
 * lock and clear the failure flag; `failed` keeps the lock held and raises
 * the visible failure. Callers render `failed` inline on the lock screen.
 */
export function resolveUnlockAfterAuth(outcome: AuthOutcome): {
  unlocked: boolean;
  failed: boolean;
} {
  if (outcome === "failed") return { unlocked: false, failed: true };
  return { unlocked: true, failed: false };
}

/** Inline lock-screen message after a failed device check, like iOS `LockView`. */
export function unlockFailureText(failed: boolean): string | null {
  return failed ? "Couldn't verify it's you." : null;
}

/**
 * Lock-episode generation guard. Every fresh lock (startup, foreground
 * relock) bumps the generation, and only the latest episode's device check
 * may open the lock: a success from an older episode — e.g. a prompt
 * answered after the app relocked behind it — is stale and must not unlock.
 * Reentry always demands its own fresh authentication.
 */
export function isStaleUnlockAttempt(args: {
  attemptGeneration: number;
  currentGeneration: number;
}): boolean {
  return args.attemptGeneration !== args.currentGeneration;
}

/**
 * Opaque background cover, mirroring iOS `PrivacyCover` (`phase != .active
 * && lock.enabled`): even unlocked, a backgrounded app with the lock on must
 * hide its content from the app switcher snapshot.
 */
export function shouldShowPrivacyCover(args: {
  locked: boolean;
  lockEnabled: boolean;
  appState: string;
}): boolean {
  return args.lockEnabled && !args.locked && args.appState !== "active";
}
