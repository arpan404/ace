import type { DeviceAdmission } from "./machine-account.ts";

/**
 * How long past its grant's expiry an account socket may stay open while its refresh is on the
 * way (a slow grant fetch, a busy socket). Short next to the five-minute grant lifetime.
 */
export const GRANT_GRACE_MS = 30_000;
/** The close code for an account socket whose grant ran out: not final, the client reconnects. */
export const GRANT_EXPIRED_CLOSE = 4014;
export const GRANT_EXPIRED_REASON = "Account grant expired";
/**
 * The close code for an account socket whose access changed (the machine signed out, moved to
 * another account, or set a new machine code). Not final: the client reconnects, and the next
 * hello gets the refusal that fits (the machine code question, or `unauthorized`).
 */
export const ACCESS_CHANGED_CLOSE = 4012;
export const ACCESS_CHANGED_REASON = "Account access changed";

/**
 * Whether an account socket still holds a grant at `now` (ADR 0111, ADR 0114): it does until
 * its grant's expiry plus the grace, then it is closed so the client reconnects with a new one.
 */
export function grantLeaseState(
  expiresAt: number,
  now: number,
  graceMs = GRANT_GRACE_MS,
): "held" | "expired" {
  return now < expiresAt + graceMs ? "held" : "expired";
}

export type GrantRefreshOutcome =
  | { kind: "extended"; expiresAt: number }
  | { kind: "refused"; code: string; message: string };

/**
 * What a socket's `account.grant.refresh` does, given how the machine judged the new grant
 * (`admitDevice`: signature, expiry, this machine's account, the socket's device id, the
 * machine code). The socket keeps the account it was admitted for: a grant for another account
 * never moves it. A grant that would end sooner than the one held never shortens it.
 */
export function grantRefreshOutcome(input: {
  admission: DeviceAdmission;
  /** The account the socket was admitted for. */
  account: string;
  /** When the socket's grant runs out now. */
  heldUntil: number;
}): GrantRefreshOutcome {
  const { admission } = input;
  if (!admission.admitted)
    return { kind: "refused", code: admission.code, message: admission.message };
  if (admission.account !== input.account)
    return { kind: "refused", code: "unauthorized", message: "That grant is for another account." };
  return { kind: "extended", expiresAt: Math.max(input.heldUntil, admission.expiresAt) };
}
