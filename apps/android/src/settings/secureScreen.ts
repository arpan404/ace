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
 * Best-effort toggle. Returns true only when the native call applied
 * synchronously. A thenable native result (any object or function with a
 * callable `then`) is NOT claimed as success: the outcome is not yet known,
 * and an async rejection must never report success (fail-closed). Callers
 * that need the async outcome must await `setSecureScreenEnabledAsync`.
 * Never throws.
 *
 * A native `false` (null activity) is propagated, never swallowed.
 *
 * The loader is injectable so tests can prove both paths without the bridge.
 */
export function setSecureScreenEnabled(enabled: boolean, loader?: () => SecureNative): boolean {
  try {
    const native = loader !== undefined ? loader() : loadAceNative();
    const result = native.setSecureScreen(enabled);
    if (result === false) return false;
    if (isThenable(result)) {
      // Async outcome unknown synchronously: report not-yet-applied so the
      // caller keeps the guarded banner until the async helper settles.
      // Adopt the thenable so then-only objects without `.catch` cannot
      // produce an unhandled rejection; the async helper is the honest path.
      void Promise.resolve(result).catch(() => undefined);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Honest async toggle: awaits thenable native results and reports the
 * settled outcome. Resolves false when there was no activity, the bridge is
 * missing, or the async application rejects; true only when applied. A
 * thenable resolving to `false` (null activity) is failure, never success.
 */
export async function setSecureScreenEnabledAsync(
  enabled: boolean,
  loader?: () => SecureNative,
): Promise<boolean> {
  try {
    const native = loader !== undefined ? loader() : loadAceNative();
    const result = native.setSecureScreen(enabled);
    if (result === false) return false;
    if (isThenable(result)) {
      try {
        const settled = await Promise.resolve(result);
        if (settled === false) return false;
        return true;
      } catch {
        return false;
      }
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

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || value === undefined) return false;
  const kind = typeof value;
  if (kind !== "object" && kind !== "function") return false;
  try {
    return typeof (value as { then?: unknown }).then === "function";
  } catch {
    return false;
  }
}
