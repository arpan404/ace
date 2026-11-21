import { encodeBase64url } from "@ace/account-grant";
import { orgHostCredentialProof } from "@ace/account-grant/machine-proof";
import type { AceAccountGrant } from "@ace/protocol/ace-account";
import type { KeyPair } from "@ace/secure-channel";
import { AccountBackendError, type accountBackend } from "./backend.ts";

/*
 * An org host's organization credential (ADR 0206 §2.1), the machine's side. Once the backend
 * holds this machine as an organization's host, the daemon signs in as the organization itself:
 * a credential with no person's session behind it, so the member who enrolled the host can sign
 * out, let their session lapse or be deprovisioned without the host leaving the relay. Only the
 * host key asks for it and renews it; the backend refuses both once the organization no longer
 * holds the host.
 */

/**
 * Asks `origin` to issue `credential` as this host's organization credential for `org`, or to
 * renew it if it already is. Idempotent: a retry after a lost answer renews what was issued.
 */
export function orgCredentialRequest(deps: {
  backend: ReturnType<typeof accountBackend>;
  relayKeys: () => Promise<KeyPair>;
  hostId: () => Promise<string>;
  now: () => number;
}) {
  return async (
    origin: string,
    org: string,
    credential: string,
    signal: AbortSignal,
  ): Promise<AceAccountGrant> => {
    const { exchangeKey } = await deps.backend.keys(origin, signal);
    if (exchangeKey === undefined)
      throw new AccountBackendError(404, "This ace account has no organization hosts.");
    const keys = await deps.relayKeys();
    const hostId = await deps.hostId();
    const at = deps.now();
    return deps.backend.orgHostCredential(
      origin,
      org,
      hostId,
      {
        hostKey: encodeBase64url(keys.publicKey),
        credential,
        at,
        proof: orgHostCredentialProof({
          hostPrivateKey: keys.privateKey,
          exchangeKey,
          terms: { hostId, org, credential, at },
        }),
      },
      signal,
    );
  };
}

/** The backend refused it for good (not this organization's host any more): no retry helps. */
export const orgCredentialRefused = (error: unknown) =>
  error instanceof AccountBackendError && error.status >= 400 && error.status < 500;
