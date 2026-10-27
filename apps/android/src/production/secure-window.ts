/**
 * Native secure-window verification for the production root.
 *
 * There is exactly one native guard: `with-ace-secure-screen` sets
 * FLAG_SECURE in `MainActivity.onCreate` before `super.onCreate` (first
 * frame), and `SecureScreenGuard` re-applies the desired state across
 * recreation. The old JS `preventScreenCaptureAsync` call ran after first
 * render and swallowed its own failure, so it is not a guard. This module
 * only verifies the native flag and fails closed when it is missing,
 * disabled, or unreachable: no directory read and no socket connect until
 * the guard is confirmed.
 *
 * The native entry is async (`AsyncFunction("secureWindowApplied")`) because
 * `window.attributes` must be read on the UI thread, never on the JS thread.
 * It resolves a boolean and never rejects; a missing Activity resolves
 * false. The async helper below is the honest path: it awaits thenables and
 * fails closed on rejection. The sync helper is a fast-path for builds that
 * still expose a synchronous boolean; it never claims success for an
 * unsettled thenable.
 */

export interface SecureWindowModule {
  secureWindowApplied?(): boolean | PromiseLike<boolean>;
}

/** True only when the native window synchronously confirms FLAG_SECURE. Never throws. */
export function isSecureWindowApplied(nativeModule: unknown): boolean {
  try {
    const candidate = nativeModule as SecureWindowModule | null | undefined;
    if (candidate === null || candidate === undefined) return false;
    if (typeof candidate.secureWindowApplied !== "function") return false;
    const result = candidate.secureWindowApplied();
    if (isThenable(result)) return false;
    return result === true;
  } catch {
    return false;
  }
}

/**
 * Honest async verification: awaits promise-like native results and reports
 * the settled outcome. Resolves true only when the native window confirms
 * FLAG_SECURE; false when the entry is missing, disabled, rejects, or throws.
 * Never rejects.
 */
export async function isSecureWindowAppliedAsync(nativeModule: unknown): Promise<boolean> {
  try {
    const candidate = nativeModule as SecureWindowModule | null | undefined;
    if (candidate === null || candidate === undefined) return false;
    if (typeof candidate.secureWindowApplied !== "function") return false;
    const settled = await Promise.resolve(candidate.secureWindowApplied());
    return settled === true;
  } catch {
    return false;
  }
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
