import { GrantError, verifyGrant, type GrantClaims, type GrantKeySet } from "@ace/account-grant";

/** Why a device grant does not open this machine. Never names the grant itself. */
export type GrantRefusal =
  | "signed_out"
  | "invalid"
  | "expired"
  | "unknown_key"
  | "other_account"
  | "other_device";

export type GrantVerdict =
  | { accepted: true; claims: GrantClaims }
  | { accepted: false; reason: GrantRefusal };

/**
 * ADR 0111's rule for a hello's grant: a `device` grant, signed by a published key and not
 * expired, for this daemon's signed-in account and for the device id the hello names. Pure.
 */
export function deviceGrantVerdict(
  token: string,
  input: {
    keys: GrantKeySet;
    now: number;
    /** The account this daemon is signed in to; undefined while signed out. */
    account: string | undefined;
    deviceId: string;
  },
): GrantVerdict {
  if (input.account === undefined) return { accepted: false, reason: "signed_out" };
  let claims: GrantClaims;
  try {
    claims = verifyGrant(token, input.keys, input.now, "device");
  } catch (error) {
    const message = error instanceof GrantError ? error.message : "";
    return {
      accepted: false,
      reason: message.includes("expired")
        ? "expired"
        : message.includes("Unknown grant key")
          ? "unknown_key"
          : "invalid",
    };
  }
  if (claims.account !== input.account) return { accepted: false, reason: "other_account" };
  if (claims.subject !== input.deviceId) return { accepted: false, reason: "other_device" };
  return { accepted: true, claims };
}
