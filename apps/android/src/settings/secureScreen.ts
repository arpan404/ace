/**
 * OS-level recents guard for the app lock.
 *
 * The JS `PrivacyCover` races the switcher snapshot: Android captures what
 * the compositor last drew, which can predate the JS `AppState` background
 * event. `FLAG_SECURE` (via `AceNative.setSecureScreen`) excludes the window
 * at composition time, so it holds regardless of JS timing. The cover stays
 * as defense in depth for the in-app transition.
 */

/** Fail-closed: blank recents until the durable lock choice is known. */
export function resolveSecureScreenEnabled(args: {
  lockEnabled: boolean;
  settingsLoaded: boolean;
  storageFailed: boolean;
}): boolean {
  if (args.storageFailed) return true;
  if (!args.settingsLoaded) return true;
  return args.lockEnabled;
}

export interface SecureNative {
  setSecureScreen(enabled: boolean): unknown;
}

/**
 * Best-effort toggle. Returns true when the native call was applied or
 * dispatched; false when there was no activity to apply to, or the bridge or
 * function is unavailable (tests, Expo Go, old build). Never throws: a
 * missing guard must not break the lock itself.
 *
 * A native `false` (null activity) is propagated, never swallowed: callers
 * must not believe the window is guarded when nothing was applied. The
 * native fail-closed default still covers not-yet-created activities.
 *
 * The loader is injectable so tests can prove both paths without the bridge.
 */
export function setSecureScreenEnabled(enabled: boolean, loader?: () => SecureNative): boolean {
  try {
    const native = loader !== undefined ? loader() : loadAceNative();
    const result = native.setSecureScreen(enabled);
    if (result === false) return false;
    if (isPromiseLike(result)) {
      result.catch(() => undefined);
    }
    return true;
  } catch {
    return false;
  }
}

function loadAceNative(): SecureNative {
  // Lazy so unit tests and bundles without the module stay alive.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const expo = require("expo") as {
    requireNativeModule(name: string): SecureNative;
  };
  return expo.requireNativeModule("AceNative");
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    "catch" in value &&
    typeof (value as { catch: unknown }).catch === "function"
  );
}
