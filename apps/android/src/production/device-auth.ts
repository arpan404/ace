/**
 * Device authentication gate for the production app lock.
 *
 * Mirrors the iOS `DeviceOwnerAuthenticator` (`apps/ios/Sources/Models/AppLock.swift`):
 * Face ID / Touch ID / biometrics with a device-passcode fallback, where only
 * a phone with no passcode at all reports `unavailable` (there is nothing to
 * unlock with). A phone with a device passcode but no enrolled biometrics must
 * still authenticate: it reports its credential state as `device`, never
 * `none`.
 *
 * The Expo `isEnrolledAsync` check this replaces reports biometric
 * enrollment, not passcode presence, so a passcode-only phone wrongly read as
 * `unavailable` and opened with no auth. Callers must map
 * `getEnrolledLevelAsync()` (`SecurityLevel.NONE` → `none`, anything else →
 * `device`) and pass the result in; anything unrecognized fails closed.
 *
 * No Expo imports here: the native surface is injected so the rules test in
 * plain Node. Production wires the real `expo-local-authentication` module
 * (see `ProductionRoot.tsx`).
 */

export type DeviceCredentialState = "none" | "device";

export type DeviceAuthOutcome = "success" | "failed" | "unavailable";

export interface DeviceAuthDeps {
  /** `none` only when the phone has no passcode/biometrics at all. */
  enrolledLevel(): Promise<DeviceCredentialState>;
  /** System prompt (biometrics with device-passcode fallback). Resolves true only on success. */
  authenticate(reason: string): Promise<boolean>;
}

/**
 * Resolve one unlock attempt. `unavailable` only when the phone itself is
 * unprotected; every error or refusal reads as `failed` so the lock stays
 * shut when the security guarantee is in doubt.
 */
export async function deviceAuthenticate(
  reason: string,
  deps: DeviceAuthDeps,
): Promise<DeviceAuthOutcome> {
  let level: DeviceCredentialState;
  try {
    level = await deps.enrolledLevel();
  } catch {
    return "failed";
  }
  if (level === "none") return "unavailable";
  try {
    return (await deps.authenticate(reason)) ? "success" : "failed";
  } catch {
    return "failed";
  }
}
