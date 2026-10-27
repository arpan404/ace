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
 */

export interface SecureWindowModule {
  secureWindowApplied?(): boolean;
}

/** True only when the native window confirms FLAG_SECURE. Never throws. */
export function isSecureWindowApplied(nativeModule: unknown): boolean {
  try {
    const candidate = nativeModule as SecureWindowModule | null | undefined;
    if (candidate === null || candidate === undefined) return false;
    if (typeof candidate.secureWindowApplied !== "function") return false;
    return candidate.secureWindowApplied() === true;
  } catch {
    return false;
  }
}
