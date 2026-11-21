import {
  GrantError,
  standingProofText,
  verifyMemberGrant,
  type GrantKeySet,
} from "@ace/account-grant";
import { signedByDeviceKey } from "./device-grant.ts";

/*
 * A member's grant on an organization's host (ADR 0206 §2.2). Format 3 grants are minted only for
 * an organization's hosts, so every one is refused on a machine no organization owns, and on one
 * owned by another organization. Pure, apart from the signature check.
 */

/** What an admitted member grant says. `role` is WorkOS's slug, mapped by `org-roles`. */
export type Member = { org: string; role: string; account: string };

export type MemberGrantVerdict =
  | {
      accepted: true;
      member: Member;
      exp: number;
      /** The device key proofs are signed with. */ key: string;
      /** The organization's policy version when the grant was minted (ADR 0206 §3). */
      policy: number;
    }
  | {
      accepted: false;
      reason:
        | "personal_machine"
        | "other_org"
        | "invalid"
        | "expired"
        | "other_device"
        | "other_host";
    };

/**
 * ADR 0206's rule for a hello's member grant: signed by a pinned key and not expired, for the
 * organization that owns this machine (`org`; undefined on a person's machine, which refuses every
 * member grant), this host and the device id the hello names. It admits the device; its standing
 * is proven on the socket (`provenMemberStanding`).
 */
export function memberGrantVerdict(
  token: string,
  input: {
    keys: GrantKeySet;
    now: number;
    org: string | undefined;
    deviceId: string;
    host: string;
  },
): MemberGrantVerdict {
  if (input.org === undefined) return { accepted: false, reason: "personal_machine" };
  let claims;
  try {
    claims = verifyMemberGrant(token, input.keys, input.now);
  } catch (error) {
    return {
      accepted: false,
      reason:
        error instanceof GrantError && error.message.includes("expired") ? "expired" : "invalid",
    };
  }
  if (claims.org !== input.org) return { accepted: false, reason: "other_org" };
  if (claims.host !== input.host) return { accepted: false, reason: "other_host" };
  if (claims.subject !== input.deviceId) return { accepted: false, reason: "other_device" };
  return {
    accepted: true,
    member: { org: claims.org, role: claims.role, account: claims.account },
    exp: claims.exp,
    key: claims.key,
    policy: claims.policy,
  };
}

/**
 * A member's standing a socket proves on an org host (ADR 0206 §2.2): `memberGrantVerdict`'s rule,
 * and `proof` is the signature, by the device key the grant names, of `standingProofText` over
 * this host, the socket's nonce, its channel binding and the grant, as a person's proof is (ADR
 * 0190). `until`: the grant's expiry, when the standing ends unless proven again.
 */
export async function provenMemberStanding(input: {
  grant: string;
  proof: string;
  nonce: string;
  binding: string | undefined;
  keys: GrantKeySet;
  now: number;
  org: string | undefined;
  deviceId: string;
  host: string;
}): Promise<{ until: number; member: Member; policy: number } | undefined> {
  const verdict = memberGrantVerdict(input.grant, input);
  if (!verdict.accepted) return undefined;
  const signed = await signedByDeviceKey(
    verdict.key,
    input.proof,
    standingProofText({
      host: input.host,
      nonce: input.nonce,
      binding: input.binding,
      grant: input.grant,
    }),
  );
  return signed
    ? { until: verdict.exp, member: verdict.member, policy: verdict.policy }
    : undefined;
}
