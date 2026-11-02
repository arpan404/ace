import { GRANT_SUBPROTOCOL_PREFIX, grantFromSubprotocols, verifyGrant } from "@ace/account-grant";
import type { AccountSetup } from "./account/config.ts";

/** Internal headers the Worker sets on upgrades it forwards to a relay object. */
export const ACCOUNT_HEADER = "Ace-Relay-Account";
export const PROTOCOL_HEADER = "Ace-Relay-Protocol";

export type Admission =
  | { admitted: true; account: string; protocol: string }
  | { admitted: false; status: number };

/**
 * Whether a `/host` or `/client` upgrade may reach a relay object (ADR 0111). The hosted relay
 * requires an account on both ends: a host needs a `machine` grant for its own host id, a
 * client a `device` grant. The relay object then admits a client only to a host on the same
 * account. Statuses: 503 accounts not configured, 401 missing or invalid grant (fetch a new
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
  let claims;
  try {
    claims = verifyGrant(
      token,
      input.setup.keys,
      input.now,
      input.endpoint === "/host" ? "machine" : "device",
    );
  } catch {
    return { admitted: false, status: 401 };
  }
  if (input.endpoint === "/host" && claims.subject !== input.hostId)
    return { admitted: false, status: 403 };
  return { admitted: true, account: claims.account, protocol: GRANT_SUBPROTOCOL_PREFIX + token };
}
