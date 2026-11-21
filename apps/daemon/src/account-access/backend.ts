import { GrantKeySet } from "@ace/account-grant";
import { AceAccountGrant } from "@ace/protocol/ace-account";
import type { AceOrgHostCredentialRequest } from "@ace/protocol/ace-org";

/** Why the account backend did not answer: 401 means the session is gone. */
export class AccountBackendError extends Error {
  override name = "AccountBackendError";
  readonly status: number;
  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}

const responseLimit = 64 * 1024;

/**
 * The account backend's published grant keys (ADR 0111), whether this machine is an
 * organization's host, and that host's organization credential (ADR 0206). Everything else (sign-in, grants) goes through
 * `@ace/client/ace-account`, which leaves keys out to keep Ed25519 from web bundles.
 */
export function accountBackend(options: { fetch: typeof fetch }) {
  async function call(url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await options.fetch(url, {
        ...init,
        signal,
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
      });
    } catch (error) {
      throw new AccountBackendError(0, "Couldn't reach your ace account.", { cause: error });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AccountBackendError(
        response.status,
        response.status === 401
          ? "Sign in to ace on this machine again."
          : "Couldn't reach your ace account.",
      );
    }
    const text = await response.text();
    if (text.length > responseLimit) throw new AccountBackendError(0, "Account response too large");
    try {
      return JSON.parse(text);
    } catch {
      throw new AccountBackendError(0, "Invalid account response");
    }
  }
  return {
    async keys(origin: string, signal: AbortSignal): Promise<GrantKeySet> {
      return GrantKeySet.parse(await call(`${origin}/v1/keys`, { method: "GET" }, signal));
    },
    /**
     * This org host's organization credential (ADR 0206 §2.1), issued or renewed on the host
     * key's proof alone: no bearer, since no person's session is behind it.
     */
    async orgHostCredential(
      origin: string,
      org: string,
      hostId: string,
      body: AceOrgHostCredentialRequest,
      signal: AbortSignal,
    ): Promise<AceAccountGrant> {
      return AceAccountGrant.parse(
        await call(
          `${origin}/v1/orgs/${encodeURIComponent(org)}/hosts/${encodeURIComponent(hostId)}/credential`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
          signal,
        ),
      );
    },
    /**
     * Whether the backend holds this machine as `org`'s host (ADR 0206 §2.1): an organization's
     * policy answers a machine credential only for one of its own hosts. False when it refuses.
     */
    async isOrgHost(origin: string, token: string, org: string, signal: AbortSignal) {
      try {
        await call(
          `${origin}/v1/orgs/${encodeURIComponent(org)}/policy`,
          { method: "GET", headers: { Authorization: `Bearer ${token}` } },
          signal,
        );
        return true;
      } catch (error) {
        if (error instanceof AccountBackendError && error.status >= 400 && error.status < 500)
          return false;
        throw error;
      }
    },
  };
}
