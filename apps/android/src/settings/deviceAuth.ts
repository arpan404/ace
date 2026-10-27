import type { AuthOutcome } from "./appLock.ts";

/**
 * Phone-local device authentication, mirroring iOS `DeviceOwnerAuthenticator`
 * (`Sources/Models/AppLock.swift`): without an enrolled device credential
 * there is nothing to unlock with (`unavailable`, which unlocks and allows
 * disabling, exactly like iOS); otherwise the prompt result decides.
 */
export function toAuthOutcome(authenticated: boolean, deviceEnrolled: boolean): AuthOutcome {
  if (!deviceEnrolled) return "unavailable";
  return authenticated ? "success" : "failed";
}
