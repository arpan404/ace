import {
  GRANT_SUBPROTOCOL_PREFIX,
  grantFromSubprotocols,
  verifyGrant,
  verifyMemberGrant,
  verifyStandingGrant,
} from "@ace/account-grant";
import type { AccountSetup } from "./account/config.ts";

/** Internal headers the Worker sets on upgrades it forwards to a relay object. */
export const ACCOUNT_HEADER = "Ace-Relay-Account";
export const PROTOCOL_HEADER = "Ace-Relay-Protocol";
/**
 * Set on a `/client` upgrade the Worker admitted by a member grant (ADR 0206 §2.2), once it
 * checked the host is that organization's: the relay object admits it whatever account the host
 * is signed in to.
 */
export const ORG_HEADER = "Ace-Relay-Org";
/** Names one forwarded HTTP request, so the Worker can cancel it when the caller leaves. */
export const EXCHANGE_HEADER = "Ace-Relay-Exchange";

export type Admission =
  | {
      admitted: true;
      account: string;
      protocol: string;
      /** A member grant's organization: the host must be that organization's host. */
      org?: string;
    }
  | { admitted: false; status: number };

/**
 * Whether a `/host` or `/client` upgrade may reach a relay object (ADR 0111). The hosted relay
 * requires an account on both ends: a host needs a `machine` grant for its own host id, a
 * client a `device` grant, or a member grant for one organization's host (ADR 0206 §2.2). The
 * relay object then admits a client only to a host on the same account, or a member to their
 * organization's host (the Worker checks it is, `ORG_HEADER`). Statuses: 503 accounts not configured, 401 missing or invalid grant (fetch a new
 * one), 403 a machine grant for another host id.
 */
export function admit(input: {
  endpoint: "/host" | "/client";
  hostId: string;
  subprotocols: string | null;
  setup: AccountSetup;
  now: number;
}): Admission {
  if (input.setup.status !== "ready") return { admitted: false, status: 503 };
  const token = grantFromSubprotocols(input.subprotocols);
  if (!token) return { admitted: false, status: 401 };
  let claims: { account: string; subject: string };
  try {
    claims = verifyGrant(
      token,
      input.setup.keys,
      input.now,
      input.endpoint === "/host" ? "machine" : "device",
    );
  } catch {
    // A client may also come with a format 2 device grant (ADR 0190), which a machine credential
    // gets instead of format 1; one bound to a host opens only that host.
    if (input.endpoint !== "/client") return { admitted: false, status: 401 };
    // A member of the organization that owns the host (ADR 0206 §2.2): the grant names that host.
    try {
      const member = verifyMemberGrant(token, input.setup.keys, input.now);
      if (member.host !== input.hostId) return { admitted: false, status: 403 };
      return {
        admitted: true,
        account: member.account,
        protocol: GRANT_SUBPROTOCOL_PREFIX + token,
        org: member.org,
      };
    } catch {
      // Not a member grant: a format 2 device grant, or nothing this relay takes.
    }
    try {
      const standing = verifyStandingGrant(token, input.setup.keys, input.now);
      if (standing.host !== undefined && standing.host !== input.hostId)
        return { admitted: false, status: 403 };
      claims = standing;
    } catch {
      return { admitted: false, status: 401 };
    }
  }
  if (input.endpoint === "/host" && claims.subject !== input.hostId)
    return { admitted: false, status: 403 };
  return { admitted: true, account: claims.account, protocol: GRANT_SUBPROTOCOL_PREFIX + token };
}
