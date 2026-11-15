import { AceAccountError } from "./ace-account.ts";
import { ClientError } from "./types.ts";

/**
 * Whether a credential that couldn't be had ends the connection or is retried with backoff.
 * Pure. Only an explicit refusal is final: the app saying the device can't connect (a
 * `ClientError` such as `auth` after sign-out or revocation), or the account service refusing
 * the sign-in (401, 403). Failing to reach whoever hands credentials out (the account backend
 * down, the network gone, a timeout) is no refusal: the connection backs off and tries again.
 */
export function credentialFailure(error: unknown): "final" | "transient" {
  if (error instanceof ClientError)
    return error.code === "offline" || error.code === "timeout" ? "transient" : "final";
  if (error instanceof AceAccountError)
    return error.status === 401 || error.status === 403 ? "final" : "transient";
  return "transient";
}
