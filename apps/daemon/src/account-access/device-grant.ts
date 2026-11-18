import {
  GrantError,
  verifyGrant,
  verifyStandingGrant,
  type GrantClaims,
  type GrantKeySet,
} from "@ace/account-grant";

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

/**
 * Whether an admitted account device speaks for the person (ADR 0190): its hello carried a
 * standing grant that says `person`, signed by a key this build pins (never one fetched from the
 * session's origin or named by the environment), for the same account and device id as its device
 * grant, and not expired. Anything less is a machine's standing. Pure.
 */
export function personStanding(
  standing: string | undefined,
  input: { keys: GrantKeySet; now: number; account: string; deviceId: string },
): boolean {
  if (standing === undefined) return false;
  try {
    const claims = verifyStandingGrant(standing, input.keys, input.now);
    return (
      claims.standing === "person" &&
      claims.account === input.account &&
      claims.subject === input.deviceId
    );
  } catch {
    return false;
  }
}
