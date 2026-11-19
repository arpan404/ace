import {
  GrantError,
  decodeBase64url,
  pairedStandingText,
  standingProofText,
  verifyGrant,
  verifyStandingGrant,
  type GrantKeySet,
} from "@ace/account-grant";

/** Why a device grant does not open this machine. Never names the grant itself. */
export type GrantRefusal =
  | "signed_out"
  | "invalid"
  | "expired"
  | "unknown_key"
  | "other_account"
  | "other_device"
  | "other_host";

/** What an admitted device grant says, in either format. */
export type AdmittedGrant = { account: string; subject: string; exp: number };
export type GrantVerdict =
  | { accepted: true; claims: AdmittedGrant }
  | { accepted: false; reason: GrantRefusal };

const refusal = (error: unknown): GrantRefusal => {
  const message = error instanceof GrantError ? error.message : "";
  return message.includes("expired")
    ? "expired"
    : message.includes("Unknown grant key")
      ? "unknown_key"
      : "invalid";
};

/**
 * ADR 0111's rule for a hello's grant: a `device` grant, signed by a published key and not
 * expired, for this daemon's signed-in account and for the device id the hello names. Format 1
 * (the person's apps, which older daemons also read) or format 2 (ADR 0190, what a machine
 * credential gets): one bound to a host opens only that host. Either admits the device with
 * admin; neither, alone, makes it the person. Pure.
 */
export function deviceGrantVerdict(
  token: string,
  input: {
    keys: GrantKeySet;
    now: number;
    /** The account this daemon is signed in to; undefined while signed out. */
    account: string | undefined;
    deviceId: string;
    /** This daemon's host id on ace's relay. */
    host: string;
  },
): GrantVerdict {
  if (input.account === undefined) return { accepted: false, reason: "signed_out" };
  let claims: AdmittedGrant;
  try {
    claims = verifyGrant(token, input.keys, input.now, "device");
  } catch (error) {
    try {
      const standing = verifyStandingGrant(token, input.keys, input.now);
      if (standing.host !== undefined && standing.host !== input.host)
        return { accepted: false, reason: "other_host" };
      claims = standing;
    } catch {
      return { accepted: false, reason: refusal(error) };
    }
  }
  if (claims.account !== input.account) return { accepted: false, reason: "other_account" };
  if (claims.subject !== input.deviceId) return { accepted: false, reason: "other_device" };
  return { accepted: true, claims };
}

/**
 * The person's standing a socket proves (ADR 0190), or undefined. The grant must be a format 2
 * person grant signed by a key this build pins (never one fetched from the session's origin or
 * named by the environment), for this daemon's account and host, the socket's device, and not
 * expired; and `proof` must be the signature, by the device key the grant names, of
 * `standingProofText` over this host, this socket's nonce, its channel binding and the grant. A
 * grant captured on the way is worthless without that key, and a proof made for one socket,
 * channel or daemon fails on any other: one relayed by whoever answered as this host, with its
 * key read from ACE_HOME, names that other channel. `until`: the grant's expiry.
 */
export async function provenStanding(input: {
  grant: string;
  proof: string;
  nonce: string;
  /** The socket's channel binding (`standingProofText`); undefined on a socket with none. */
  binding: string | undefined;
  keys: GrantKeySet;
  now: number;
  account: string;
  deviceId: string;
  host: string;
}): Promise<{ until: number } | undefined> {
  let claims;
  try {
    claims = verifyStandingGrant(input.grant, input.keys, input.now);
  } catch {
    return undefined;
  }
  if (
    claims.standing !== "person" ||
    claims.account !== input.account ||
    claims.subject !== input.deviceId ||
    claims.host !== input.host ||
    claims.key === undefined
  )
    return undefined;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(decodeBase64url(claims.key)),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const signed = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new Uint8Array(decodeBase64url(input.proof)),
      new TextEncoder().encode(
        standingProofText({
          host: input.host,
          nonce: input.nonce,
          binding: input.binding,
          grant: input.grant,
        }),
      ),
    );
    return signed ? { until: claims.exp } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a device paired from a person's link proved, on this socket, that it holds the key it
 * named when it redeemed that link (ADR 0190): `proof` is its signature of `pairedStandingText`
 * over this host, this socket's nonce and channel binding, and its device id. Its bearer token,
 * which whoever answered as this host could have collected, proves nothing.
 */
export async function provenDevice(input: {
  /** The device's standing key, base64url raw P-256. */
  key: string;
  proof: string;
  host: string;
  nonce: string;
  binding: string | undefined;
  deviceId: string;
}): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(decodeBase64url(input.key)),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new Uint8Array(decodeBase64url(input.proof)),
      new TextEncoder().encode(pairedStandingText(input)),
    );
  } catch {
    return false;
  }
}
